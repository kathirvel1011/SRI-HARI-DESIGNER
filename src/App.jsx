import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search, Menu, X, ArrowUpRight, Phone, Mail, MapPin, ShieldCheck, Heart, Image as ImageIcon, UserRound, Settings, LockKeyhole, LogOut, Upload, Pencil, Trash2, Download, FileArchive, FileText } from "lucide-react";
import { fetchAllRows, supabase, uploadFileWithProgress } from "./supabase.js";
import { ACCEPTED_DESIGN_EXTENSIONS, ACCEPTED_PREVIEW_EXTENSIONS, createWatermarkedDesignPreview, getDesignFileExtension, getLegacyDesignAsset, isPreviewableDesignFile, MAX_DESIGN_FILE_COUNT, MAX_DESIGN_FILE_SIZE, validateDesignFile } from "./designFiles.js";
import SuperAdminDashboard from "./SuperAdminDashboard.jsx";

function getCurrentRoute() {
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
  return pathname !== "/" ? pathname : window.location.hash || "#home";
}

const DESIGN_CATALOGUE_REFRESH_KEY = "sri-hari-designer:catalogue-updated";
const DESIGN_CATALOGUE_REFRESH_EVENT = "sri-hari-designer-catalogue-refresh";

function announceDesignCatalogueRefresh() {
  window.dispatchEvent(new Event(DESIGN_CATALOGUE_REFRESH_EVENT));
  try {
    window.localStorage.setItem(DESIGN_CATALOGUE_REFRESH_KEY, String(Date.now()));
  } catch {
    // The local event still refreshes the current tab if storage is unavailable.
  }
}

async function fetchDesignRowsWithPreview(buildCurrentQuery, buildLegacyQuery) {
  try {
    return await fetchAllRows(buildCurrentQuery);
  } catch (error) {
    if (!/column designs\.preview_path does not exist|preview_path.*schema cache/i.test(error.message || "")) throw error;
    return fetchAllRows(buildLegacyQuery);
  }
}

function formatFileSize(size) {
  if (!Number.isFinite(size) || size < 0) return "Size unavailable";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function DesignPreview({ url, name, className }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return <div className={[className, "design-image-placeholder"].filter(Boolean).join(" ")}><FileText size={25}/><span>{name || "Design file"}</span></div>;
  }
  return <img className={className} src={url} alt={name || "Design preview"} loading="lazy" onError={() => setFailed(true)}/>;
}

function SubBrandLogo({ subBrand, className = "" }) {
  const [failed, setFailed] = useState(false);
  if (!subBrand?.logoUrl || failed) {
    return <span className={`design-subbrand-logo design-subbrand-placeholder ${className}`} aria-label={`${subBrand?.name || "Sub-brand"} logo unavailable`}><ImageIcon size={16}/></span>;
  }
  return <img className={`design-subbrand-logo ${className}`} src={subBrand.logoUrl} alt={`${subBrand.name} logo`} loading="lazy" onError={() => setFailed(true)}/>;
}

function DesignDetailsDialog({ design, categoryName, isFavorite, likeCount, likeCountError, likeBusy, likeDisabled, onClose, onToggleFavorite }) {
  return (
    <div className="design-detail-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="design-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="design-detail-title">
        <button className="auth-close" type="button" aria-label="Close design details" onClick={onClose}><X size={20}/></button>
        <DesignPreview className="design-detail-image" url={design.imageUrl} name={design.imageName || design.name}/>
        <div className="eyebrow">DESIGN DETAILS</div>
        <h2 id="design-detail-title">{design.name}</h2>
        {design.serial_number && <p className="design-detail-serial">Serial number: {design.serial_number}</p>}
        {categoryName && <p className="design-detail-category">Category: {categoryName}</p>}
        {design.subBrand && <div className="design-subbrand-detail"><SubBrandLogo subBrand={design.subBrand}/><span>{design.subBrand.name}</span></div>}
        {design.description && <p className="design-detail-description">{design.description}</p>}
        <div className="design-detail-like-row">
          <button className={isFavorite ? "favorite-toggle active" : "favorite-toggle"} type="button" aria-label={isFavorite ? "Unlike design" : "Like design"} aria-pressed={isFavorite} disabled={likeBusy || likeDisabled} onClick={onToggleFavorite}>
            <Heart size={17} fill={isFavorite ? "currentColor" : "none"}/>
          </button>
          <span>{likeCountError ? "Like count unavailable" : `${likeCount} ${likeCount === 1 ? "like" : "likes"}`}</span>
        </div>
        {Array.isArray(design.keywords) && design.keywords.length > 0 && (
          <div className="design-detail-keywords">{design.keywords.map((keyword, index) => <span key={`${keyword}-${index}`}>{keyword}</span>)}</div>
        )}
        <button className="button button-quiet design-detail-back" type="button" onClick={onClose}>Back to designs</button>
      </section>
    </div>
  );
}

async function addSignedDesignAssets(rows) {
  const imageWarnings = [];
  const items = [];
  for (let offset = 0; offset < rows.length; offset += 25) {
    const batch = await Promise.all(rows.slice(offset, offset + 25).map(async (design) => {
      const { data: previewData, error: previewError } = design.preview_path
        ? await supabase.storage.from("design-previews").createSignedUrl(design.preview_path, 10 * 60)
        : { data: null, error: null };
      if (previewError) imageWarnings.push(previewError.message);
      const relatedSubBrand = Array.isArray(design.sub_brands) ? design.sub_brands[0] : design.sub_brands;
      let subBrand = relatedSubBrand ? { ...relatedSubBrand, logoUrl: null } : null;
      if (subBrand?.logo_path) {
        for (const bucket of ["sub-brand-logos", "design-images"]) {
          const { data, error } = await supabase.storage
            .from(bucket)
            .createSignedUrl(subBrand.logo_path, 60 * 60);
          if (!error) {
            subBrand = { ...subBrand, logoUrl: data.signedUrl };
            break;
          }
        }
      }
      return {
        ...design,
        fileAssets: Array.isArray(design.fileAssets) ? design.fileAssets : [],
        imageUrl: previewData?.signedUrl || null,
        imageName: design.name,
        subBrand,
      };
    }));
    items.push(...batch);
  }
  return { items, imageWarnings };
}

async function generateMissingDesignPreview(design, ownerId) {
  if (design.preview_path) return design;
  const legacyAsset = design.image_path ? getLegacyDesignAsset(design.image_path) : null;
  const asset = design.fileAssets?.find((item) => isPreviewableDesignFile(item.name)) || legacyAsset;
  if (!asset?.path || !isPreviewableDesignFile(asset.name)) return design;

  let previewPath;
  try {
    const { data: signedData, error: signedError } = await supabase.storage
      .from("design-images")
      .createSignedUrl(asset.path, 60);
    if (signedError) throw signedError;
    const originalResponse = await fetch(signedData.signedUrl);
    if (!originalResponse.ok) throw new Error("The original design file could not be opened.");
    const originalBlob = await originalResponse.blob();
    const originalFile = new File([originalBlob], asset.name, { type: asset.type || originalBlob.type });
    const previewFile = await createWatermarkedDesignPreview(originalFile);
    if (!previewFile) return design;

    previewPath = `design-previews/${ownerId}/${design.id}-${crypto.randomUUID()}.${getDesignFileExtension(previewFile.name) || "webp"}`;
    const { error: uploadError } = await supabase.storage.from("design-previews").upload(previewPath, previewFile, {
      cacheControl: "3600",
      contentType: previewFile.type,
      upsert: false,
    });
    if (uploadError) throw uploadError;
    const { data, error } = await supabase.from("designs")
      .update({ preview_path: previewPath })
      .eq("id", design.id)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("The preview could not be saved under the current permissions.");
    return { ...design, preview_path: previewPath };
  } catch (error) {
    if (previewPath) await supabase.storage.from("design-previews").remove([previewPath]);
    throw error;
  }
}

async function fetchDesignFavouriteCounts(designIds) {
  const uniqueIds = [...new Set(designIds)];
  if (!uniqueIds.length) return { counts: {}, error: null };
  const { data, error } = await supabase.rpc("get_design_favourite_counts", { p_design_ids: uniqueIds });
  if (error) return { counts: {}, error };
  const counts = Object.fromEntries(uniqueIds.map((id) => [id, 0]));
  (data || []).forEach((row) => { counts[row.design_id] = Number(row.like_count) || 0; });
  return { counts, error: null };
}

function App() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All designs");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [user, setUser] = useState(null);
  const [customerProfile, setCustomerProfile] = useState(null);
  const [profileStatus, setProfileStatus] = useState("signed_out");
  const [profileError, setProfileError] = useState("");
  const [profileRefresh, setProfileRefresh] = useState(0);
  const [designCategories, setDesignCategories] = useState([]);
  const [publicCategories, setPublicCategories] = useState([]);
  const [publicCategoryStatus, setPublicCategoryStatus] = useState("loading");
  const [publicCategoryError, setPublicCategoryError] = useState("");
  const [designItems, setDesignItems] = useState([]);
  const [publicDesignItems, setPublicDesignItems] = useState([]);
  const [publicCatalogueStatus, setPublicCatalogueStatus] = useState("loading");
  const [publicCatalogueError, setPublicCatalogueError] = useState("");
  const [designLoadStatus, setDesignLoadStatus] = useState("idle");
  const [designLoadError, setDesignLoadError] = useState("");
  const [designImageWarning, setDesignImageWarning] = useState("");
  const [designRefresh, setDesignRefresh] = useState(0);
  const [favoriteDesignIds, setFavoriteDesignIds] = useState([]);
  const [favoriteCounts, setFavoriteCounts] = useState({});
  const [favoriteCountError, setFavoriteCountError] = useState("");
  const [favoritesStatus, setFavoritesStatus] = useState("idle");
  const [favoritesError, setFavoritesError] = useState("");
  const [favoriteBusyId, setFavoriteBusyId] = useState("");
  const [adminDesignSearch, setAdminDesignSearch] = useState("");
  const [adminDesignSort, setAdminDesignSort] = useState("newest");
  const [adminDesignPage, setAdminDesignPage] = useState(1);
  const [adminSubBrands, setAdminSubBrands] = useState([]);
  const [adminOptionsStatus, setAdminOptionsStatus] = useState("idle");
  const [adminOptionsError, setAdminOptionsError] = useState("");
  const [uploadForm, setUploadForm] = useState({
    name: "",
    serialNumber: "",
    description: "",
    keywords: "",
    categoryId: "",
    subBrandId: "",
    files: [],
    previewFile: null,
  });
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadProgress, setUploadProgress] = useState([]);
  const [adminDesignEdit, setAdminDesignEdit] = useState(null);
  const [adminDesignEditBusy, setAdminDesignEditBusy] = useState(false);
  const [adminDesignActionError, setAdminDesignActionError] = useState("");
  const [adminDesignActionMessage, setAdminDesignActionMessage] = useState("");
  const [originalDownloadError, setOriginalDownloadError] = useState("");
  const [originalDownloadBusyPath, setOriginalDownloadBusyPath] = useState("");
  const [adminDeleteBusyId, setAdminDeleteBusyId] = useState(null);
  const designFilesInputRef = useRef(null);
  const filePreviewUrlsRef = useRef(new Set());
  const favoriteBusyIdsRef = useRef(new Set());
  const [designCategoryId, setDesignCategoryId] = useState("all");
  const [designSearch, setDesignSearch] = useState("");
  const [selectedDesign, setSelectedDesign] = useState(null);
  const [currentRoute, setCurrentRoute] = useState(getCurrentRoute);
  const roleRedirectUserId = useRef(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState("login");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [authForm, setAuthForm] = useState({
    fullName: "",
    email: "",
    phone: "",
    password: "",
    confirmPassword: "",
  });
  const [settingsPassword, setSettingsPassword] = useState("");
  const [settingsConfirmPassword, setSettingsConfirmPassword] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [settingsMessage, setSettingsMessage] = useState("");
  const [profileEditing, setProfileEditing] = useState(false);
  const [profileForm, setProfileForm] = useState({ fullName: "", phone: "" });
  const [profileSaveBusy, setProfileSaveBusy] = useState(false);
  const [profileSaveError, setProfileSaveError] = useState("");
  const [profileSaveMessage, setProfileSaveMessage] = useState("");

  useEffect(() => () => {
    filePreviewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    filePreviewUrlsRef.current.clear();
  }, []);

  useEffect(() => {
    let active = true;
    const loadPublicCategories = async () => {
      setPublicCategoryStatus("loading");
      setPublicCategoryError("");
      try {
        const { data, error } = await supabase
          .from("categories")
          .select("id, name, description")
          .eq("is_active", true)
          .order("name");
        if (error) throw error;
        if (!active) return;
        const rows = data || [];
        setPublicCategories(rows);
        setCategory((current) => current === "All designs" || rows.some((item) => item.name === current)
          ? current
          : "All designs");
        setPublicCategoryStatus("loaded");
      } catch (error) {
        if (!active) return;
        setPublicCategoryError(error instanceof Error ? error.message : "Active categories could not be loaded.");
        setPublicCategoryStatus("error");
      }
    };

    const handleFocus = () => { void loadPublicCategories(); };
    void loadPublicCategories();
    window.addEventListener("focus", handleFocus);
    return () => {
      active = false;
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  useEffect(() => {
    if (!supabase) return undefined;
    let active = true;
    const loadPublicDesigns = async () => {
      setPublicCatalogueStatus("loading");
      setPublicCatalogueError("");
      try {
        const buildQuery = (includePreviewPath) => supabase.from("designs")
          .select(`id, serial_number, name, description, keywords, category_id, sub_brand_id, sub_brands(id,name,logo_path), ${includePreviewPath ? "preview_path, " : ""}created_at`)
          .eq("is_published", true)
          .order("created_at", { ascending: false })
          .order("id");
        const rows = await fetchDesignRowsWithPreview(
          () => buildQuery(true),
          () => buildQuery(false),
        );
        const { items, imageWarnings } = await addSignedDesignAssets(rows);
        const { counts, error: countError } = await fetchDesignFavouriteCounts(items.map((item) => item.id));
        if (!active) return;
        setPublicDesignItems(items);
        setFavoriteCounts(counts);
        setFavoriteCountError(countError?.message || "");
        setPublicCatalogueError(imageWarnings.length ? `Some published design files could not be opened: ${imageWarnings[0]}` : "");
        setPublicCatalogueStatus("loaded");
      } catch (error) {
        if (!active) return;
        setPublicCatalogueError(error instanceof Error ? error.message : "Published designs could not be loaded.");
        setPublicCatalogueStatus("error");
      }
    };
    const onStorage = (event) => {
      if (event.key === DESIGN_CATALOGUE_REFRESH_KEY) void loadPublicDesigns();
    };
    void loadPublicDesigns();
    window.addEventListener("focus", loadPublicDesigns);
    window.addEventListener(DESIGN_CATALOGUE_REFRESH_EVENT, loadPublicDesigns);
    window.addEventListener("storage", onStorage);
    return () => {
      active = false;
      window.removeEventListener("focus", loadPublicDesigns);
      window.removeEventListener(DESIGN_CATALOGUE_REFRESH_EVENT, loadPublicDesigns);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    if (!supabase) return undefined;
    let active = true;
    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) setAuthError(error.message);
      setUser(data.session?.user ?? null);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
            setUser((current) => (current?.id === session?.user?.id ? current : (session?.user ?? null)));
      if (event === "PASSWORD_RECOVERY") {
        setAuthMode("reset");
        setAuthOpen(true);
      }
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const handleLocationChange = () => setCurrentRoute(getCurrentRoute());
    window.addEventListener("popstate", handleLocationChange);
    window.addEventListener("hashchange", handleLocationChange);
    return () => {
      window.removeEventListener("popstate", handleLocationChange);
      window.removeEventListener("hashchange", handleLocationChange);
    };
  }, []);

  useEffect(() => {
    if (!selectedDesign) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setSelectedDesign(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedDesign]);

  useEffect(() => {
    if (!user) {
      setCustomerProfile(null);
      setProfileError("");
      setProfileStatus("signed_out");
      return undefined;
    }

    let active = true;
    setCustomerProfile(null);
    setProfileError("");
    setProfileStatus("loading");

    supabase
      .from("profiles")
      .select("id, full_name, email, phone, role, is_active")
      .eq("id", user.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          setProfileError(error.message);
          setProfileStatus("error");
        } else if (!data || data.id !== user.id) {
          setProfileError("Your account profile is missing. Access was denied.");
          setProfileStatus("denied");
        } else if (data.is_active !== true) {
          setProfileError("This account is inactive. Contact the site administrator for assistance.");
          setProfileStatus("denied");
        } else if (data.role === "public_user") {
          setCustomerProfile(data);
          setProfileStatus("customer");
        } else if (data.role === "super_admin") {
          setCustomerProfile(data);
          setProfileStatus("super_admin");
        } else if (data.role === "admin") {
          setCustomerProfile(data);
          setProfileStatus("admin");
        } else {
          setProfileError("Your account role or status could not be verified. Access was denied.");
          setProfileStatus("denied");
        }
      })
      .catch((error) => {
        if (!active) return;
        setProfileError(error instanceof Error ? error.message : "The customer profile could not be loaded.");
        setProfileStatus("error");
      });

    return () => {
      active = false;
    };
  }, [user, profileRefresh]);

  useEffect(() => {
    if (!user || roleRedirectUserId.current !== user.id) return;
    if (!["error", "denied"].includes(profileStatus) && customerProfile?.id !== user.id) return;

    if (profileStatus === "error" || profileStatus === "denied") {
      roleRedirectUserId.current = null;
      setAuthError(profileError || "Your account could not be verified. Access was denied.");
      setAuthOpen(true);
      return;
    }

    const destination = profileStatus === "super_admin"
      ? "/super-admin"
      : profileStatus === "admin" ? "/admin/downloads" : "/dashboard";
    window.history.replaceState(null, "", destination);
    setCurrentRoute(destination);
    roleRedirectUserId.current = null;
  }, [user, customerProfile, profileStatus, profileError]);

  useEffect(() => {
    if (!user || profileStatus !== "customer" || customerProfile?.id !== user.id) {
      setDesignCategories([]);
      setDesignItems([]);
      setDesignLoadStatus("idle");
      setDesignLoadError("");
      setDesignImageWarning("");
      setFavoriteDesignIds([]);
      setFavoriteCounts({});
      setFavoriteCountError("");
      setFavoritesStatus("idle");
      setFavoritesError("");
      setSelectedDesign(null);
      return undefined;
    }

    let active = true;
    setDesignLoadStatus("loading");
    setDesignLoadError("");
    setDesignImageWarning("");
    setFavoritesStatus("loading");
    setFavoritesError("");

    const loadDesigns = async () => {
      const [
        { data: categoryRows, error: categoryError },
        designRows,
        { data: favoriteRows, error: favoriteError },
      ] = await Promise.all([
        supabase
            .from("categories")
            .select("id, name, description")
            .eq("is_active", true)
            .order("name"),
        fetchDesignRowsWithPreview(
          () => supabase.from("designs")
            .select("id, serial_number, name, description, keywords, category_id, sub_brand_id, sub_brands(id,name,logo_path), preview_path, created_at")
            .eq("is_published", true)
            .order("created_at", { ascending: false })
            .order("id"),
          () => supabase.from("designs")
            .select("id, serial_number, name, description, keywords, category_id, sub_brand_id, sub_brands(id,name,logo_path), created_at")
            .eq("is_published", true)
            .order("created_at", { ascending: false })
            .order("id"),
        )
          .catch((error) => {
            throw new Error(`Designs could not be loaded: ${error.message}`);
          }),
        supabase
          .from("favourites")
          .select("design_id")
          .eq("user_id", user.id),
      ]);

      if (categoryError) throw new Error(`Categories could not be loaded: ${categoryError.message}`);

      const { items: itemsWithImageUrls, imageWarnings } = await addSignedDesignAssets(designRows);
      const { counts, error: countError } = await fetchDesignFavouriteCounts(itemsWithImageUrls.map((item) => item.id));

      if (!active) return;
      setDesignCategories(categoryRows || []);
      setDesignItems(itemsWithImageUrls);
      setFavoriteCounts(counts);
      setFavoriteCountError(countError?.message || "");
      if (favoriteError) {
        setFavoriteDesignIds([]);
        setFavoritesError(`Favourites could not be loaded: ${favoriteError.message}`);
        setFavoritesStatus("error");
      } else {
        setFavoriteDesignIds((favoriteRows || []).map((item) => item.design_id));
        setFavoritesStatus("loaded");
      }
      setDesignImageWarning(imageWarnings.length
        ? `Some design images could not be opened with your current Storage permissions: ${imageWarnings[0]}`
        : "");
      setDesignLoadStatus("loaded");
    };

    loadDesigns().catch((error) => {
      if (!active) return;
      setDesignLoadError(error instanceof Error ? error.message : "The design catalogue could not be loaded.");
      setDesignLoadStatus("error");
      setFavoritesStatus("error");
      setFavoritesError(error instanceof Error ? error.message : "The customer dashboard data could not be loaded.");
    });

    return () => {
      active = false;
    };
  }, [user, profileStatus, customerProfile?.id, designRefresh]);

  useEffect(() => {
    const hasAdminAccess = profileStatus === "super_admin"
      && customerProfile?.id === user?.id;
    if (!user || !hasAdminAccess) {
      setAdminSubBrands([]);
      setAdminOptionsStatus("idle");
      setAdminOptionsError("");
      return undefined;
    }

    let active = true;
    setAdminOptionsStatus("loading");
    setAdminOptionsError("");

    const loadAdminOptions = async () => {
      const [{ data: categoryRows, error: categoryError }, { data: subBrandRows, error: subBrandError }] =
        await Promise.all([
          supabase.from("categories").select("id, name, description").eq("is_active", true).order("name"),
          supabase.from("sub_brands").select("id, name, admin_user_id, is_active").eq("is_active", true).order("name"),
        ]);
      if (categoryError) throw new Error(`Categories could not be loaded: ${categoryError.message}`);
      if (subBrandError) throw new Error(`Sub-brands could not be loaded: ${subBrandError.message}`);

      if (!active) return;
      setDesignCategories(categoryRows || []);
      setAdminSubBrands(subBrandRows || []);
      setUploadForm((current) => ({
        ...current,
        categoryId: current.categoryId || categoryRows?.[0]?.id || "",
        subBrandId: current.subBrandId,
      }));
      setAdminOptionsStatus("loaded");
    };

    loadAdminOptions().catch((error) => {
      if (!active) return;
      setAdminOptionsError(error instanceof Error ? error.message : "Admin upload options could not be loaded.");
      setAdminOptionsStatus("error");
    });

    return () => {
      active = false;
    };
  }, [user, profileStatus, customerProfile?.id]);

  useEffect(() => {
    const hasDesignManagerAccess = ["admin", "super_admin"].includes(profileStatus)
      && customerProfile?.id === user?.id;
    if (!user || !hasDesignManagerAccess) return undefined;

    let active = true;
    setDesignLoadStatus("loading");
    setDesignLoadError("");
    setDesignImageWarning("");

    const loadAdminDesigns = async () => {
      const manager = await getVerifiedDesignManagerUser();
      const buildQuery = (includePreviewPath) => supabase
        .from("designs")
        .select(`id, serial_number, name, description, keywords, category_id, sub_brand_id, sub_brands(id,name,logo_path), ${includePreviewPath ? "preview_path, " : ""}is_published, created_at`)
        .order("created_at", { ascending: false })
        .order("id");
      const designRows = await fetchDesignRowsWithPreview(
        () => buildQuery(true),
        () => buildQuery(false),
      );
      const { data: originalFiles, error: originalFilesError } = await supabase.rpc("get_design_original_files", {
        p_design_ids: designRows.map((design) => design.id),
      });
      if (originalFilesError) throw new Error(`Original file access could not be verified: ${originalFilesError.message}`);
      let rowsWithFiles = designRows.map((design) => ({
        ...design,
        fileAssets: (originalFiles || []).filter((file) => file.design_id === design.id),
      }));
      const previewWarnings = [];
      if (manager.role === "super_admin") {
        rowsWithFiles = await Promise.all(rowsWithFiles.map(async (design) => {
          try {
            return await generateMissingDesignPreview(design, manager.user.id);
          } catch (error) {
            previewWarnings.push(error instanceof Error ? error.message : "A design preview could not be generated.");
            return design;
          }
        }));
      }

      const { items: itemsWithImageUrls, imageWarnings } = await addSignedDesignAssets(rowsWithFiles);

      if (!active) return;
      setDesignItems(itemsWithImageUrls);
      setDesignImageWarning(previewWarnings.length || imageWarnings.length
        ? `Some design previews could not be opened: ${previewWarnings[0] || imageWarnings[0]}`
        : "");
      setDesignLoadStatus("loaded");
    };

    loadAdminDesigns().catch((error) => {
      if (!active) return;
      setDesignLoadError(error instanceof Error ? error.message : "Your designs could not be loaded.");
      setDesignLoadStatus("error");
    });

    return () => {
      active = false;
    };
  }, [user, profileStatus, customerProfile?.id, designRefresh]);

  const visibleDesigns = useMemo(() => publicDesignItems.filter((item) => {
    const categoryName = publicCategories.find((entry) => entry.id === item.category_id)?.name || "";
    const matchesCategory = category === "All designs" || categoryName === category;
    const searchTerm = query.trim().toLocaleLowerCase();
    const matchesQuery = !searchTerm || [item.serial_number, item.name, categoryName, item.description]
      .some((value) => String(value || "").toLocaleLowerCase().includes(searchTerm));
    return matchesCategory && matchesQuery;
  }), [publicDesignItems, publicCategories, query, category]);
  const filteredDesignItems = useMemo(() => {
    const searchTerm = designSearch.trim().toLocaleLowerCase();
    return designItems.filter((design) => {
      const matchesCategory = designCategoryId === "all" || design.category_id === designCategoryId;
      const matchesSearch = !searchTerm || [design.name, design.serial_number]
        .some((value) => String(value || "").toLocaleLowerCase().includes(searchTerm));
      return matchesCategory && matchesSearch;
    });
  }, [designItems, designCategoryId, designSearch]);
  const favoriteDesigns = useMemo(
    () => designItems.filter((design) => favoriteDesignIds.includes(design.id)),
    [designItems, favoriteDesignIds],
  );
  const sortedAdminDesigns = useMemo(() => [...filteredDesignItems].sort((a, b) => {
    if (adminDesignSort === "name") return a.name.localeCompare(b.name);
    if (adminDesignSort === "serial") return String(a.serial_number || "").localeCompare(String(b.serial_number || ""));
    return new Date(b.created_at || 0) - new Date(a.created_at || 0);
  }), [filteredDesignItems, adminDesignSort]);
  const adminDesignPageSize = 12;
  const adminDesignPageCount = Math.max(1, Math.ceil(sortedAdminDesigns.length / adminDesignPageSize));
  const pagedAdminDesigns = sortedAdminDesigns.slice(
    (adminDesignPage - 1) * adminDesignPageSize,
    adminDesignPage * adminDesignPageSize,
  );

  const closeMenu = () => setMobileOpen(false);
  const openAuth = (mode = "login") => {
    setAuthMode(mode);
    setAuthError("");
    setAuthMessage("");
    setAuthOpen(true);
    closeMenu();
  };

  const toggleFavorite = async (designId) => {
    if (!isVerifiedCustomer) {
      openAuth("login");
      return;
    }
    if (favoriteBusyIdsRef.current.has(designId)) return;
    favoriteBusyIdsRef.current.add(designId);
    setFavoritesError("");
    setFavoriteBusyId(designId);
    try {
      const { data: { user: authenticatedUser }, error: authError } = await supabase.auth.getUser();
      if (authError) throw authError;
      if (!authenticatedUser || authenticatedUser.id !== user?.id || profileStatus !== "customer") {
        throw new Error("Your customer session could not be verified. Sign in again.");
      }

      const isFavorite = favoriteDesignIds.includes(designId);
      if (isFavorite) {
        const { data, error } = await supabase
          .from("favourites")
          .delete()
          .eq("user_id", authenticatedUser.id)
          .eq("design_id", designId)
          .select("id")
          .maybeSingle();
        if (error) throw error;
        if (!data) throw new Error("The favourite could not be removed under the current database permissions.");
        setFavoriteDesignIds((current) => current.filter((id) => id !== designId));
        setFavoriteCounts((current) => ({ ...current, [designId]: Math.max(0, (current[designId] || 0) - 1) }));
      } else {
        const { error } = await supabase
          .from("favourites")
          .upsert(
            { user_id: authenticatedUser.id, design_id: designId },
            { onConflict: "user_id,design_id", ignoreDuplicates: true },
          );
        if (error) throw error;
        setFavoriteDesignIds((current) => current.includes(designId) ? current : [...current, designId]);
        setFavoriteCounts((current) => ({ ...current, [designId]: (current[designId] || 0) + 1 }));
      }
    } catch (error) {
      setFavoritesError(error instanceof Error ? error.message : "The favourite could not be updated.");
    } finally {
      favoriteBusyIdsRef.current.delete(designId);
      setFavoriteBusyId("");
    }
  };

  const handleAuthSubmit = async (event) => {
    event.preventDefault();
    setAuthError("");
    setAuthMessage("");
    setAuthBusy(true);
    try {
      if (!supabase) {
        throw new Error("Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local, then restart the dev server.");
      }
      const email = authForm.email.trim();
      if (authMode === "register") {
        if (authForm.password !== authForm.confirmPassword) {
          throw new Error("Passwords do not match.");
        }
        const { data, error } = await supabase.auth.signUp({
          email,
          password: authForm.password,
          options: {
            data: {
              full_name: authForm.fullName.trim(),
              phone: authForm.phone.trim(),
            },
          },
        });
        if (error) throw error;
        if (data.session?.user) {
          roleRedirectUserId.current = data.session.user.id;
          setUser(data.session.user);
          setAuthOpen(false);
        } else {
          setAuthMessage("Registration was submitted, but Supabase did not return a login session. You are not logged in. If email confirmation is required, confirm your email and then log in. Otherwise, try logging in.");
        }
      } else if (authMode === "login") {
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password: authForm.password,
        });
        if (error) throw error;
        const authenticatedUser = data.session?.user;
        if (!authenticatedUser) {
          throw new Error("Supabase did not return an active login session.");
        }
        roleRedirectUserId.current = authenticatedUser.id;
        setUser(authenticatedUser);
        setAuthOpen(false);
      } else if (authMode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin,
        });
        if (error) throw error;
        setAuthMessage("If an account exists for that email, a password reset link has been sent.");
      } else if (authMode === "reset") {
        if (authForm.password !== authForm.confirmPassword) {
          throw new Error("Passwords do not match.");
        }
        const { error } = await supabase.auth.updateUser({ password: authForm.password });
        if (error) throw error;
        setAuthMessage("Your password has been updated.");
      }
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "The authentication request failed.");
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogout = async () => {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) {
      setAuthError(error.message);
      setAuthOpen(true);
      return;
    }
    roleRedirectUserId.current = null;
    setUser(null);
    window.history.replaceState(null, "", "/");
    setCurrentRoute("#home");
  };

  const handleSettingsSubmit = async (event) => {
    event.preventDefault();
    setSettingsError("");
    setSettingsMessage("");
    if (settingsPassword !== settingsConfirmPassword) {
      setSettingsError("Passwords do not match.");
      return;
    }
    setSettingsBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: settingsPassword });
      if (error) throw error;
      setSettingsPassword("");
      setSettingsConfirmPassword("");
      setSettingsMessage("Your password has been updated.");
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "The password could not be updated.");
    } finally {
      setSettingsBusy(false);
    }
  };

  const beginProfileEdit = () => {
    setProfileForm({
      fullName: customerProfile?.full_name || "",
      phone: customerProfile?.phone || "",
    });
    setProfileSaveError("");
    setProfileSaveMessage("");
    setProfileEditing(true);
  };

  const cancelProfileEdit = () => {
    setProfileEditing(false);
    setProfileSaveError("");
    setProfileSaveMessage("");
    setProfileForm({ fullName: "", phone: "" });
  };

  const handleProfileSave = async (event) => {
    event.preventDefault();
    setProfileSaveError("");
    setProfileSaveMessage("");
    if (!user || !customerProfile || customerProfile.id !== user.id) {
      setProfileSaveError("Your customer account could not be verified. Please sign in again.");
      return;
    }

    setProfileSaveBusy(true);
    try {
      const { data: { user: authenticatedUser }, error: authError } = await supabase.auth.getUser();
      if (authError) throw authError;
      if (!authenticatedUser || authenticatedUser.id !== user.id) {
        throw new Error("Your session changed. Please sign in again.");
      }

      const { data, error } = await supabase
        .from("profiles")
        .update({
          full_name: profileForm.fullName.trim(),
          phone: profileForm.phone.trim(),
        })
        .eq("id", authenticatedUser.id)
        .eq("role", "public_user")
        .select("id, full_name, email, phone, role")
        .maybeSingle();

      if (error) throw error;
      if (!data || data.id !== authenticatedUser.id || data.role !== "public_user") {
        throw new Error("Your profile was not updated. Check that your profile permissions allow this change.");
      }

      setCustomerProfile(data);
      setProfileSaveMessage("Your profile has been updated.");
      setProfileEditing(false);
    } catch (error) {
      setProfileSaveError(error instanceof Error ? error.message : "Your profile could not be updated.");
    } finally {
      setProfileSaveBusy(false);
    }
  };

  const getVerifiedAdminUser = async () => {
    const manager = await getVerifiedDesignManagerUser();
    if (manager.role !== "super_admin") {
      throw new Error("An active Super Admin account is required for this action.");
    }
    return manager.user;
  };

  const getVerifiedDesignManagerUser = async () => {
    const { data: { user: authenticatedUser }, error: authError } = await supabase.auth.getUser();
    if (authError) throw authError;
    if (!authenticatedUser || authenticatedUser.id !== user?.id) {
      throw new Error("Your session could not be verified. Sign in again before downloading original files.");
    }

    const { data: managerProfile, error: profileLookupError } = await supabase
      .from("profiles")
      .select("id, role, is_active")
      .eq("id", authenticatedUser.id)
      .maybeSingle();
    if (profileLookupError) throw profileLookupError;
    if (
      !managerProfile
      || managerProfile.id !== authenticatedUser.id
      || !["admin", "super_admin"].includes(managerProfile.role)
      || managerProfile.is_active !== true
    ) {
      throw new Error("An active Admin or Super Admin account is required to download original files.");
    }
    return { user: authenticatedUser, role: managerProfile.role };
  };

  const downloadOriginalFile = async (design, requestedAsset) => {
    const downloadKey = `${design.id}:${requestedAsset.path}`;
    setOriginalDownloadError("");
    setOriginalDownloadBusyPath(downloadKey);
    try {
      await getVerifiedDesignManagerUser();
      const { data: files, error: filesError } = await supabase.rpc("get_design_original_files", {
        p_design_ids: [design.id],
      });
      if (filesError) throw filesError;
      const authorizedAsset = (files || []).find((file) => file.path === requestedAsset.path);
      if (!authorizedAsset) throw new Error("This file is not attached to the selected design.");

      const { data, error } = await supabase.storage
        .from("design-images")
        .createSignedUrl(authorizedAsset.path, 60, { download: authorizedAsset.name });
      if (error) throw error;
      const link = document.createElement("a");
      link.href = data.signedUrl;
      link.download = authorizedAsset.name;
      link.rel = "noopener noreferrer";
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      setOriginalDownloadError(error instanceof Error ? error.message : "The original file could not be downloaded.");
    } finally {
      setOriginalDownloadBusyPath("");
    }
  };

  const handleDesignFilesChange = (event, editMode = false) => {
    const selectedFiles = Array.from(event.target.files || []);
    if (selectedFiles.length > MAX_DESIGN_FILE_COUNT) {
      if (editMode) setAdminDesignActionError(`Choose no more than ${MAX_DESIGN_FILE_COUNT} files at a time.`);
      else setUploadError(`Choose no more than ${MAX_DESIGN_FILE_COUNT} files at a time.`);
      event.target.value = "";
      return;
    }

    const previousFiles = editMode ? adminDesignEdit?.files || [] : uploadForm.files;
    previousFiles.forEach(({ previewUrl }) => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        filePreviewUrlsRef.current.delete(previewUrl);
      }
    });
    const files = selectedFiles.map((file) => {
      const previewUrl = isPreviewableDesignFile(file) ? URL.createObjectURL(file) : null;
      if (previewUrl) filePreviewUrlsRef.current.add(previewUrl);
      return { file, previewUrl };
    });
    if (editMode) {
      setAdminDesignEdit((current) => ({ ...current, files }));
      setAdminDesignActionError("");
    } else {
      setUploadForm((current) => ({ ...current, files }));
      setUploadError("");
    }
    setUploadProgress([]);
  };

  const uploadDesignFiles = async (files, ownerId, updateProgress, rememberPath, rememberPreviewPath, previewSourceFile = null) => {
    const validatedFiles = await Promise.all(files.map(async ({ file }) => ({
      file,
      validation: await validateDesignFile(file),
    })));
    const uploadedAssets = [];
    for (const [index, item] of validatedFiles.entries()) {
      const extensionStart = item.file.name.lastIndexOf(".");
      const originalExtension = extensionStart >= 0
        ? item.file.name.slice(extensionStart).replace(/[^a-zA-Z0-9.]/g, "")
        : `.${item.validation.extension}`;
      const safeBaseName = (extensionStart >= 0 ? item.file.name.slice(0, extensionStart) : item.file.name)
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .replace(/^\.+/, "")
        .slice(0, 140) || "design";
      const safeFileName = `${safeBaseName}${originalExtension || `.${item.validation.extension}`}`;
      const path = `designs/${ownerId}/${crypto.randomUUID()}-${safeFileName}`;
      rememberPath(path);
      updateProgress(index, 0, "Uploading");
      await uploadFileWithProgress("design-images", path, item.file, item.validation.contentType, (percent) => {
        updateProgress(index, percent, "Uploading");
      });
      updateProgress(index, 100, "Uploaded");
      uploadedAssets.push({
        name: item.file.name,
        path,
        type: item.validation.contentType,
        size: item.file.size,
      });
    }
    let previewPath = null;
    const manualPreviewValidation = previewSourceFile ? await validateDesignFile(previewSourceFile) : null;
    if (manualPreviewValidation && !manualPreviewValidation.preview) {
      throw new Error("Choose an image file for the customer-facing preview.");
    }
    const previewSource = previewSourceFile
      ? { file: previewSourceFile }
      : validatedFiles.find(({ validation }) => validation.preview);
    if (previewSource) {
      const previewFile = await createWatermarkedDesignPreview(previewSource.file);
      if (previewFile) {
        const extension = getDesignFileExtension(previewFile.name) || "webp";
        previewPath = `design-previews/${ownerId}/${crypto.randomUUID()}.${extension}`;
        rememberPreviewPath(previewPath);
        await uploadFileWithProgress("design-previews", previewPath, previewFile, previewFile.type, () => {});
      }
    }
    return { assets: uploadedAssets, previewPath };
  };

  const handleAdminUpload = async (event) => {
    event.preventDefault();
    setUploadError("");
    setUploadMessage("");
    if (profileStatus !== "super_admin" || customerProfile?.id !== user?.id) {
      setUploadError("Super Admin access could not be verified.");
      return;
    }
    if (adminOptionsStatus !== "loaded") {
      setUploadError("Categories and sub-brand permissions must load before you can upload.");
      return;
    }
    if (!uploadForm.name.trim() || !uploadForm.categoryId || !uploadForm.files.length) {
      setUploadError("Enter a design name, choose a category, and select at least one design file.");
      return;
    }
    if (uploadForm.files.length > MAX_DESIGN_FILE_COUNT) {
      setUploadError(`Choose no more than ${MAX_DESIGN_FILE_COUNT} files at a time.`);
      return;
    }
    const isPublished = event.nativeEvent.submitter?.value === "publish";
    if (isPublished && !uploadForm.previewFile && !uploadForm.files.some(({ file }) => isPreviewableDesignFile(file))) {
      setUploadError("Add a public preview image before publishing this design.");
      return;
    }
    if (!designCategories.some((item) => item.id === uploadForm.categoryId)) {
      setUploadError("Choose an active category from the list.");
      return;
    }
    if (uploadForm.serialNumber.trim() && designItems.some((design) => (
      design.serial_number?.trim().toLocaleLowerCase() === uploadForm.serialNumber.trim().toLocaleLowerCase()
    ))) {
      setUploadError("That serial number is already used by another design.");
      return;
    }

    setUploadBusy(true);
    let uploadedPaths = [];
    let uploadedPreviewPaths = [];
    setUploadProgress(uploadForm.files.map(({ file }) => ({ name: file.name, percent: 0, status: "Waiting" })));
    try {
      const authenticatedUser = await getVerifiedAdminUser();
      let subBrandId = uploadForm.subBrandId || null;
      if (subBrandId && !adminSubBrands.some((item) => item.id === subBrandId)) {
        throw new Error("Choose an active sub-brand from the available list.");
      }

      const { assets: uploadedAssets, previewPath } = await uploadDesignFiles(
        uploadForm.files,
        authenticatedUser.id,
        (index, percent, status) => setUploadProgress((current) => current.map((item, itemIndex) => (
          itemIndex === index ? { ...item, percent, status } : item
        ))),
        (path) => uploadedPaths.push(path),
        (path) => uploadedPreviewPaths.push(path),
        uploadForm.previewFile,
      );
      if (isPublished && !previewPath) {
        throw new Error("A watermarked public preview could not be generated. Choose a separate preview image and retry publishing.");
      }

      const keywords = uploadForm.keywords
        .split(/[,\n]/)
        .map((keyword) => keyword.trim())
        .filter(Boolean);
      const { error: insertError } = await supabase.from("designs").insert({
        name: uploadForm.name.trim(),
        serial_number: uploadForm.serialNumber.trim() || null,
        description: uploadForm.description.trim() || null,
        keywords,
        category_id: uploadForm.categoryId,
        image_path: uploadedAssets.find((asset) => isPreviewableDesignFile(asset.name))?.path || uploadedAssets[0].path,
        file_assets: uploadedAssets,
        preview_path: previewPath,
        uploaded_by: authenticatedUser.id,
        sub_brand_id: subBrandId,
        is_published: isPublished,
      });

      if (insertError) {
        throw new Error(`Design could not be saved: ${insertError.message}`);
      }

      uploadedPaths = [];
      uploadedPreviewPaths = [];
      uploadForm.files.forEach(({ previewUrl }) => {
        if (previewUrl) {
          URL.revokeObjectURL(previewUrl);
          filePreviewUrlsRef.current.delete(previewUrl);
        }
      });
      setUploadForm({
        name: "",
        serialNumber: "",
        description: "",
        keywords: "",
        categoryId: designCategories[0]?.id || "",
        subBrandId: "",
        files: [],
        previewFile: null,
      });
      if (designFilesInputRef.current) designFilesInputRef.current.value = "";
      setUploadProgress([]);
      setUploadMessage(isPublished ? "Design published successfully." : "Design saved as a draft.");
      if (isPublished) announceDesignCatalogueRefresh();
      setAdminDesignActionError("");
      setAdminDesignActionMessage("");
      setDesignRefresh((value) => value + 1);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "The design could not be uploaded.");
      setUploadProgress((current) => current.map((item) => item.status === "Uploaded" ? item : { ...item, status: "Failed" }));
      if (uploadedPaths.length) {
        const { error: cleanupError } = await supabase.storage.from("design-images").remove(uploadedPaths);
        if (cleanupError) {
          setUploadError((message) => `${message} The uploaded image could not be removed: ${cleanupError.message}`);
        }
        uploadedPaths = [];
      }
      if (uploadedPreviewPaths.length) {
        const { error: cleanupError } = await supabase.storage.from("design-previews").remove(uploadedPreviewPaths);
        if (cleanupError) setUploadError((message) => `${message} The preview could not be removed: ${cleanupError.message}`);
        uploadedPreviewPaths = [];
      }
    } finally {
      setUploadBusy(false);
    }
  };

  const beginAdminDesignEdit = (design) => {
    setAdminDesignActionError("");
    setAdminDesignActionMessage("");
    setAdminDesignEdit({
      id: design.id,
      name: design.name || "",
      serialNumber: design.serial_number || "",
      description: design.description || "",
      keywords: Array.isArray(design.keywords) ? design.keywords.join(", ") : "",
      categoryId: design.category_id || "",
      files: [],
      previewFile: null,
    });
  };

  const closeAdminDesignEdit = () => {
    (adminDesignEdit?.files || []).forEach(({ previewUrl }) => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        filePreviewUrlsRef.current.delete(previewUrl);
      }
    });
    setUploadProgress([]);
    setAdminDesignEdit(null);
  };

  const saveAdminDesignEdit = async (event) => {
    event.preventDefault();
    if (!adminDesignEdit) return;
    setAdminDesignActionError("");
    setAdminDesignActionMessage("");
    setAdminDesignEditBusy(true);
    let uploadedEditPaths = [];
    let uploadedEditPreviewPaths = [];
    try {
      await getVerifiedAdminUser();
      if (!adminDesignEdit.name.trim()) throw new Error("Design name is required.");
      if (!designCategories.some((item) => item.id === adminDesignEdit.categoryId)) {
        throw new Error("Choose an active category from the list.");
      }
      if (adminDesignEdit.serialNumber.trim() && designItems.some((design) => (
        design.id !== adminDesignEdit.id
        && design.serial_number?.trim().toLocaleLowerCase() === adminDesignEdit.serialNumber.trim().toLocaleLowerCase()
      ))) {
        throw new Error("That serial number is already used by another design.");
      }
      const currentDesign = designItems.find((design) => design.id === adminDesignEdit.id);
      const existingAssets = (currentDesign?.fileAssets || []).map(({ name, path, type, size }) => ({ name, path, type, size }));
      if (existingAssets.length + adminDesignEdit.files.length > MAX_DESIGN_FILE_COUNT) {
        throw new Error(`A design can contain no more than ${MAX_DESIGN_FILE_COUNT} files.`);
      }
      setUploadProgress(adminDesignEdit.files.map(({ file }) => ({ name: file.name, percent: 0, status: "Waiting" })));
      const { assets: uploadedAssets, previewPath } = await uploadDesignFiles(
        adminDesignEdit.files,
        user.id,
        (index, percent, status) => setUploadProgress((current) => current.map((item, itemIndex) => (
          itemIndex === index ? { ...item, percent, status } : item
        ))),
        (path) => uploadedEditPaths.push(path),
        (path) => uploadedEditPreviewPaths.push(path),
        adminDesignEdit.previewFile,
      );

      const updateValues = {
        name: adminDesignEdit.name.trim(),
        serial_number: adminDesignEdit.serialNumber.trim() || null,
        description: adminDesignEdit.description.trim() || null,
        keywords: adminDesignEdit.keywords.split(/[,\n]/).map((value) => value.trim()).filter(Boolean),
        category_id: adminDesignEdit.categoryId,
      };
      if (uploadedAssets.length) {
        const allAssets = [...existingAssets, ...uploadedAssets];
        updateValues.file_assets = allAssets;
        updateValues.image_path = uploadedAssets.find((asset) => isPreviewableDesignFile(asset.name))?.path
          || existingAssets.find((asset) => isPreviewableDesignFile(asset.name))?.path
          || existingAssets[0]?.path
          || uploadedAssets[0].path;
      }
      if (previewPath) updateValues.preview_path = previewPath;
      const update = supabase.from("designs").update(updateValues).eq("id", adminDesignEdit.id);
      const { data, error } = await update.select("id").maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("The design could not be updated under the current permissions.");

      uploadedEditPaths = [];
      uploadedEditPreviewPaths = [];
      adminDesignEdit.files.forEach(({ previewUrl }) => {
        if (previewUrl) {
          URL.revokeObjectURL(previewUrl);
          filePreviewUrlsRef.current.delete(previewUrl);
        }
      });
      setUploadProgress([]);
      setAdminDesignEdit(null);
      setAdminDesignActionMessage(uploadedAssets.length ? "Design details and files updated." : "Design details updated.");
      announceDesignCatalogueRefresh();
      setDesignRefresh((value) => value + 1);
    } catch (error) {
      setAdminDesignActionError(error instanceof Error ? error.message : "Design details could not be updated.");
      setUploadProgress((current) => current.map((item) => item.status === "Uploaded" ? item : { ...item, status: "Failed" }));
      if (uploadedEditPaths.length) {
        const { error: cleanupError } = await supabase.storage.from("design-images").remove(uploadedEditPaths);
        if (cleanupError) {
          setAdminDesignActionError((message) => `${message} The uploaded image could not be removed: ${cleanupError.message}`);
        }
        uploadedEditPaths = [];
      }
      if (uploadedEditPreviewPaths.length) {
        const { error: cleanupError } = await supabase.storage.from("design-previews").remove(uploadedEditPreviewPaths);
        if (cleanupError) setAdminDesignActionError((message) => `${message} The preview could not be removed: ${cleanupError.message}`);
        uploadedEditPreviewPaths = [];
      }
    } finally {
      setAdminDesignEditBusy(false);
    }
  };

  const setAdminDesignPublished = async (design, isPublished) => {
    setAdminDesignActionError("");
    setAdminDesignActionMessage("");
    try {
      await getVerifiedAdminUser();
      const { data, error } = await supabase.from("designs")
        .update({ is_published: isPublished })
        .eq("id", design.id)
        .select("id, is_published")
        .maybeSingle();
      if (error) throw error;
      if (!data || data.id !== design.id || data.is_published !== isPublished) {
        throw new Error("The design status could not be changed under the current permissions.");
      }
      setAdminDesignActionMessage(isPublished ? "Design published." : "Design unpublished.");
      announceDesignCatalogueRefresh();
      setDesignRefresh((value) => value + 1);
    } catch (error) {
      setAdminDesignActionError(error instanceof Error ? error.message : "Design status could not be changed.");
    }
  };

  const deleteAdminDesign = async (design) => {
    if (!window.confirm(`Delete "${design.name}"? This cannot be undone.`)) return;
    setAdminDesignActionError("");
    setAdminDesignActionMessage("");
    setAdminDeleteBusyId(design.id);
    try {
      await getVerifiedAdminUser();
      let removeDesign = supabase.from("designs").delete().eq("id", design.id);
      const { data, error } = await removeDesign.select("id").maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("The design could not be deleted under the current permissions.");
      setAdminDesignPage(1);

      const assetPaths = [...new Set((design.fileAssets || []).map((asset) => asset.path).filter(Boolean))];
      const { error: storageError } = assetPaths.length
        ? await supabase.storage.from("design-images").remove(assetPaths)
        : { error: null };
      const { error: previewError } = design.preview_path
        ? await supabase.storage.from("design-previews").remove([design.preview_path])
        : { error: null };
      if (storageError) {
        setAdminDesignActionError(`Design record deleted, but its image could not be removed: ${storageError.message}`);
      } else if (previewError) {
        setAdminDesignActionError(`Design deleted, but its private preview could not be removed: ${previewError.message}`);
      } else {
        setAdminDesignActionMessage("Design deleted.");
      }
      announceDesignCatalogueRefresh();
      setDesignRefresh((value) => value + 1);
    } catch (error) {
      setAdminDesignActionError(error instanceof Error ? error.message : "The design could not be deleted.");
    } finally {
      setAdminDeleteBusyId(null);
    }
  };

  const setAuthField = (field) => (event) => {
    setAuthForm((current) => ({ ...current, [field]: event.target.value }));
  };

  const isDashboardRoute = currentRoute === "#dashboard" || currentRoute === "/dashboard";
  const isSuperAdminRoute = currentRoute === "/super-admin";
  const isAdminDownloadsRoute = currentRoute === "/admin/downloads";
  const isAdminUploadRoute = currentRoute === "#admin-upload"
    || currentRoute === "/admin/upload"
    || currentRoute === "/super-admin/add-design";
  const isAdminDesignsRoute = currentRoute === "#admin-designs"
    || currentRoute === "/admin"
    || currentRoute === "/super-admin/designs";
  const isAdminRoute = isAdminUploadRoute || isAdminDesignsRoute || isAdminDownloadsRoute;
  const isProtectedRoute = isDashboardRoute || isSuperAdminRoute || isAdminRoute;
  const isVerifiedCustomer = Boolean(
    user && profileStatus === "customer" && customerProfile?.id === user.id,
  );
  const isVerifiedSuperAdmin = Boolean(
    user && profileStatus === "super_admin" && customerProfile?.id === user.id,
  );
  const isVerifiedDesignManager = Boolean(
    user && ["admin", "super_admin"].includes(profileStatus) && customerProfile?.id === user.id,
  );
  const isProfileCheckPending = Boolean(
    user && ["signed_out", "loading"].includes(profileStatus),
  );

  return (
    <div className="site-shell">
      <div className="topline">TEXTILE DESIGN COLLECTION <span>•</span> QUALITY • CREATIVITY • TRUST</div>
      <header className={isVerifiedDesignManager ? "header admin-header" : "header"}>
        <a className="brand" href="/#home" aria-label="Sri Hari Designer home" onClick={closeMenu}>
          <img src="/brand-logo.jpeg" alt="Sri Hari Designer official logo" />
          <span className="brand-copy"><strong>SRI HARI DESIGNER</strong><small>TEXTILE DESIGN COLLECTION</small></span>
        </a>
        <button className="menu-toggle" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Toggle navigation">
          {mobileOpen ? <X /> : <Menu />}
        </button>
        <nav className={mobileOpen ? "nav open" : "nav"}>
          <a href="/#home" onClick={closeMenu}>Home</a>
          <a href="/#designs" onClick={closeMenu}>Designs</a>
          <a href="/#about" onClick={closeMenu}>About</a>
          <a href="/#contact" onClick={closeMenu}>Contact</a>
          {user ? (
            <>
              {isVerifiedCustomer && (
                <>
                  <a href="/dashboard" onClick={closeMenu}>Dashboard</a>
                  <span className="user-greeting">{customerProfile.full_name?.trim() || "My Account"}</span>
                </>
              )}
              {isVerifiedSuperAdmin && (
                <>
                  <a href="/super-admin" onClick={closeMenu}>Super Admin Dashboard</a>
                  <span className="user-greeting">{customerProfile.full_name?.trim() || "Super Admin"}</span>
                </>
              )}
              {isVerifiedDesignManager && <a href="/admin/downloads" onClick={closeMenu}>Original Files</a>}
              <button className="login-link" type="button" onClick={handleLogout}>Logout</button>
            </>
          ) : (
            <button className="login-link" type="button" onClick={() => openAuth("login")}>Login / Register <ArrowUpRight size={15}/></button>
          )}
        </nav>
      </header>

      <main>
        {user && !isProtectedRoute && profileStatus === "error" && (
          <div className="dashboard-message" role="alert">
            <h2>Unable to verify your account</h2>
            <p>{profileError}</p>
            <button className="button button-primary" type="button" onClick={() => setProfileRefresh((value) => value + 1)}>Try again</button>
          </div>
        )}
        {user && !isProtectedRoute && profileStatus === "denied" && (
          <div className="dashboard-message" role="alert">
            <h2>Account access denied</h2>
            <p>{profileError || "Your account profile or role could not be verified."}</p>
            <button className="button button-quiet" type="button" onClick={handleLogout}>Sign out</button>
          </div>
        )}
        {isSuperAdminRoute ? (
          <section className="customer-dashboard section admin-dashboard super-admin-route">
            {!user && (
              <div className="dashboard-message">
                <h1>Super Admin sign-in required</h1>
                <p>Sign in with an active Super Admin account to continue.</p>
                <button className="button button-primary" type="button" onClick={() => openAuth("login")}>Log in</button>
              </div>
            )}
            {isProfileCheckPending && <div className="dashboard-message" role="status">Verifying Super Admin access…</div>}
            {profileStatus === "error" && (
              <div className="dashboard-message" role="alert">
                <h1>Unable to verify your account</h1>
                <p>{profileError}</p>
                <button className="button button-primary" type="button" onClick={() => setProfileRefresh((value) => value + 1)}>Try again</button>
              </div>
            )}
            {user && profileStatus === "denied" && (
              <div className="dashboard-message" role="alert">
                <h1>Super Admin access only</h1>
                <p>{profileError || "This dashboard is available only to the active Super Admin account."}</p>
                <a className="button button-quiet" href="/#home">Return to home</a>
              </div>
            )}
            {isVerifiedSuperAdmin && (
              <SuperAdminDashboard profile={customerProfile} onLogout={handleLogout} />
            )}
          </section>
        ) : isAdminDownloadsRoute ? (
          <section className="customer-dashboard section admin-dashboard">
            {!user && (
              <div className="dashboard-message">
                <h1>Admin sign-in required</h1>
                <p>Sign in with an active Admin or Super Admin account to access original files.</p>
                <button className="button button-primary" type="button" onClick={() => openAuth("login")}>Log in</button>
              </div>
            )}
            {isProfileCheckPending && <div className="dashboard-message" role="status">Verifying file access…</div>}
            {profileStatus === "error" && <div className="dashboard-message" role="alert"><h1>Unable to verify your account</h1><p>{profileError}</p></div>}
            {user && !isProfileCheckPending && !isVerifiedDesignManager && profileStatus !== "error" && (
              <div className="dashboard-message" role="alert">
                <h1>Admin access only</h1>
                <p>Original design files are available only to an active Admin or Super Admin account.</p>
                <a className="button button-quiet" href="/#home">Return to home</a>
              </div>
            )}
            {isVerifiedDesignManager && (
              <>
                <div className="dashboard-welcome">
                  <div><div className="eyebrow">PRIVATE ORIGINAL FILES</div><h1>Design downloads</h1><p>Original files are available to verified Admin accounts only.</p></div>
                  <button className="button dashboard-logout" type="button" onClick={handleLogout}><LogOut size={16}/> Logout</button>
                </div>
                <section className="dashboard-card admin-designs-card">
                  {originalDownloadError && <p className="auth-feedback auth-error" role="alert">{originalDownloadError}</p>}
                  {designLoadStatus === "loading" && <p role="status">Loading authorized design files…</p>}
                  {designLoadStatus === "error" && <p className="auth-feedback auth-error" role="alert">{designLoadError}</p>}
                  {designLoadStatus === "loaded" && designItems.map((design) => (
                    <article className="admin-design-item" key={design.id}>
                      <DesignPreview url={design.imageUrl} name={design.name}/>
                      <div className="admin-design-content">
                        <div className="admin-design-title-row"><div><h3>{design.name}</h3><p>{design.serial_number || "No serial number"}</p></div></div>
                        <div className="design-file-list">
                          {design.fileAssets.map((asset) => {
                            const downloadKey = `${design.id}:${asset.path}`;
                            return (
                              <div className="design-file-row" key={asset.path}>
                                <button className="design-original-download" type="button" disabled={originalDownloadBusyPath === downloadKey} onClick={() => void downloadOriginalFile(design, asset)}>
                                  <Download size={15}/><span>{originalDownloadBusyPath === downloadKey ? "Preparing secure download…" : asset.name}</span>
                                </button>
                                <small>.{getDesignFileExtension(asset.name)} · {formatFileSize(asset.size)}</small>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </article>
                  ))}
                </section>
              </>
            )}
          </section>
        ) : isAdminRoute ? (
          <section className="customer-dashboard section admin-dashboard">
            {isProfileCheckPending && <div className="dashboard-message" role="status">Verifying Super Admin access…</div>}
            {!user && (
              <div className="dashboard-message">
                <h1>Super Admin sign-in required</h1>
                <p>Sign in with an active Super Admin account to continue.</p>
                <button className="button button-primary" type="button" onClick={() => openAuth("login")}>Log in</button>
              </div>
            )}
            {profileStatus === "error" && (
              <div className="dashboard-message" role="alert">
                <h1>Unable to verify your account</h1>
                <p>{profileError}</p>
                <button className="button button-primary" type="button" onClick={() => setProfileRefresh((value) => value + 1)}>Try again</button>
              </div>
            )}
            {user && !isProfileCheckPending && !isVerifiedSuperAdmin && profileStatus !== "error" && (
              <div className="dashboard-message" role="alert">
                <h1>Super Admin access only</h1>
                <p>This design management feature is available only to the active Super Admin account.</p>
                <a className="button button-quiet" href="/#home">Return to home</a>
              </div>
            )}
            {isVerifiedSuperAdmin && (
              <>
                <div className="dashboard-welcome">
                  <div>
                    <div className="eyebrow">SUPER ADMIN DESIGN MANAGEMENT</div>
                    <h1>{isAdminUploadRoute ? "Upload a Design" : "Manage Designs"}</h1>
                    <p>{customerProfile.full_name?.trim() || "Super Admin"} · Super Admin</p>
                  </div>
                  <div className="admin-page-actions">
                    <a className="button button-quiet" href="/super-admin/designs">Manage Designs</a>
                    <a className="button button-primary" href="/super-admin/add-design"><Upload size={15}/> Add Design</a>
                  </div>
                </div>
                {isAdminUploadRoute ? (
                  <section className="dashboard-card admin-upload-card">
                    <div className="dashboard-card-heading"><Upload size={19}/><h2>Design Details</h2></div>
                    {adminOptionsStatus === "loading" && <p role="status">Loading categories and sub-brand access…</p>}
                    {adminOptionsError && <p className="auth-feedback auth-error" role="alert">{adminOptionsError}</p>}
                    {uploadError && <p className="auth-feedback auth-error" role="alert">{uploadError}</p>}
                    {uploadMessage && <p className="auth-feedback auth-success" role="status">{uploadMessage}</p>}
                    <form className="admin-upload-form" onSubmit={handleAdminUpload}>
                      <label>
                        Design name <span aria-hidden="true">*</span>
                        <input required maxLength={200} value={uploadForm.name} onChange={(event) => setUploadForm((current) => ({ ...current, name: event.target.value }))} />
                      </label>
                      <label>
                        Serial number
                        <input maxLength={200} value={uploadForm.serialNumber} onChange={(event) => setUploadForm((current) => ({ ...current, serialNumber: event.target.value }))} />
                      </label>
                      <label>
                        Category <span aria-hidden="true">*</span>
                        <select required value={uploadForm.categoryId} disabled={adminOptionsStatus !== "loaded"} onChange={(event) => setUploadForm((current) => ({ ...current, categoryId: event.target.value }))}>
                          <option value="" disabled>Select a category</option>
                          {designCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                        </select>
                      </label>
                      <label>
                        Sub-brand
                        <select
                          value={uploadForm.subBrandId}
                          disabled={adminOptionsStatus !== "loaded"}
                          onChange={(event) => setUploadForm((current) => ({ ...current, subBrandId: event.target.value }))}
                        >
                          <option value="">No sub-brand</option>
                          {adminSubBrands.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                        </select>
                      </label>
                      <label>
                        Description
                        <textarea rows="4" maxLength={5000} value={uploadForm.description} onChange={(event) => setUploadForm((current) => ({ ...current, description: event.target.value }))}/>
                      </label>
                      <label>
                        Keywords <small>Separate keywords with commas or new lines.</small>
                        <textarea rows="3" value={uploadForm.keywords} onChange={(event) => setUploadForm((current) => ({ ...current, keywords: event.target.value }))}/>
                      </label>
                      <label className="admin-image-field">
                        Upload your design files – Images, BMP, SVG, EPS, AI, CDR, PDF and more. <span aria-hidden="true">*</span>
                        <input ref={designFilesInputRef} type="file" required disabled={uploadBusy} onChange={(event) => handleDesignFilesChange(event)}/>
                        <small>Up to {MAX_DESIGN_FILE_COUNT} original files, {formatFileSize(MAX_DESIGN_FILE_SIZE)} each. Original files remain private.</small>
                        {uploadForm.files.map(({ file, previewUrl }, index) => {
                          const FileIcon = ["zip", "rar"].includes(getDesignFileExtension(file.name)) ? FileArchive : FileText;
                          const progress = uploadProgress[index];
                          return (
                            <div className="design-upload-file" key={`${file.name}-${file.lastModified}-${index}`}>
                              {previewUrl ? <img src={previewUrl} alt=""/> : <span className="design-upload-file-icon"><FileIcon size={20}/></span>}
                              <div className="design-upload-file-info">
                                <strong title={file.name}>{file.name}</strong>
                                <span>.{getDesignFileExtension(file.name)} · {formatFileSize(file.size)}</span>
                                {progress && <><progress max="100" value={progress.percent}/><span role="status">{progress.status} · {progress.percent}%</span></>}
                              </div>
                            </div>
                          );
                        })}
                      </label>
                      <label className="admin-image-field">
                        Public preview image
                        <input type="file" accept={ACCEPTED_PREVIEW_EXTENSIONS} disabled={uploadBusy} onChange={(event) => setUploadForm((current) => ({ ...current, previewFile: event.target.files?.[0] || null }))}/>
                        <small>Optional for image originals. Required to publish formats that browsers cannot preview. A watermarked copy is stored separately.</small>
                        {uploadForm.previewFile && <small>Selected preview: {uploadForm.previewFile.name} · {formatFileSize(uploadForm.previewFile.size)}</small>}
                      </label>
                      <div className="profile-edit-actions">
                        <button className="button button-quiet" type="submit" name="intent" value="draft" disabled={uploadBusy || adminOptionsStatus !== "loaded" || designCategories.length === 0 || !uploadForm.files.length}>{uploadBusy ? "Saving…" : "Save as Draft"}</button>
                        <button className="button button-primary" type="submit" name="intent" value="publish" disabled={uploadBusy || adminOptionsStatus !== "loaded" || designCategories.length === 0 || !uploadForm.files.length}>{uploadBusy ? "Uploading…" : "Publish Design"}</button>
                      </div>
                    </form>
                  </section>
                ) : (
                  <section className="dashboard-card admin-designs-card">
                    <div className="dashboard-card-heading"><ImageIcon size={19}/><h2>{profileStatus === "super_admin" ? "All Designs" : "Your Designs"}</h2></div>
                    {adminDesignActionError && <p className="auth-feedback auth-error" role="alert">{adminDesignActionError}</p>}
                    {adminDesignActionMessage && <p className="auth-feedback auth-success" role="status">{adminDesignActionMessage}</p>}
                    {originalDownloadError && <p className="auth-feedback auth-error" role="alert">{originalDownloadError}</p>}
                    {designImageWarning && <p className="auth-feedback auth-error" role="alert">{designImageWarning}</p>}
                    {designLoadStatus === "loading" && <p role="status">Loading designs…</p>}
                    {designLoadStatus === "error" && <div className="empty-state"><h3>Designs could not be loaded</h3><p>{designLoadError}</p><button className="text-button" type="button" onClick={() => setDesignRefresh((value) => value + 1)}>Try again</button></div>}
                    {designLoadStatus === "loaded" && designItems.length === 0 && <div className="empty-state"><h3>No designs uploaded yet</h3><p>Upload a design to begin building the catalogue.</p><a className="button button-primary" href="/super-admin/add-design">Add Design</a></div>}
                    {designLoadStatus === "loaded" && designItems.length > 0 && (
                      <>
                      <div className="admin-design-toolbar">
                        <input
                          type="search"
                          aria-label="Search designs"
                          placeholder="Search name or serial number"
                          value={designSearch}
                          onChange={(event) => { setDesignSearch(event.target.value); setAdminDesignPage(1); }}
                        />
                        <select aria-label="Filter designs by category" value={designCategoryId} onChange={(event) => { setDesignCategoryId(event.target.value); setAdminDesignPage(1); }}>
                          <option value="all">All categories</option>
                          {designCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                        </select>
                        <select aria-label="Sort designs" value={adminDesignSort} onChange={(event) => { setAdminDesignSort(event.target.value); setAdminDesignPage(1); }}>
                          <option value="newest">Newest first</option>
                          <option value="name">Name</option>
                          <option value="serial">Serial number</option>
                        </select>
                      </div>
                      <div className="admin-design-list">
                        {pagedAdminDesigns.map((design) => (
                          <article className="admin-design-item" key={design.id}>
                            <DesignPreview url={design.imageUrl} name={design.imageName || design.name}/>
                            <div className="admin-design-content">
                              <div className="admin-design-title-row">
                                <div><h3>{design.name}</h3><p>{design.serial_number || "No serial number"}</p></div>
                                <span className={design.is_published ? "design-status published" : "design-status draft"}>{design.is_published ? "Published" : "Draft"}</span>
                              </div>
                              <p>{designCategories.find((item) => item.id === design.category_id)?.name || "Category unavailable"}</p>
                              {design.subBrand && <div className="design-subbrand-line"><SubBrandLogo subBrand={design.subBrand}/><span>{design.subBrand.name}</span></div>}
                              {design.description && <p className="admin-design-description">{design.description}</p>}
                              <div className="design-file-list">
                                {design.fileAssets?.map((asset) => (
                                  <div className="design-file-row" key={asset.path}>
                                    <button className="design-original-download" type="button" disabled={originalDownloadBusyPath === `${design.id}:${asset.path}`} onClick={() => void downloadOriginalFile(design, asset)}>
                                      <Download size={15}/><span>{originalDownloadBusyPath === `${design.id}:${asset.path}` ? "Preparing secure download…" : asset.name}</span>
                                    </button>
                                    <small>.{getDesignFileExtension(asset.name)} · {formatFileSize(asset.size)}</small>
                                  </div>
                                ))}
                              </div>
                              <div className="admin-design-actions">
                                <button type="button" className="text-button" onClick={() => beginAdminDesignEdit(design)}><Pencil size={14}/> Edit details</button>
                                <button type="button" className="text-button" onClick={() => setAdminDesignPublished(design, !design.is_published)}>{design.is_published ? "Unpublish" : "Publish"}</button>
                                <button type="button" className="text-button danger-text" disabled={adminDeleteBusyId === design.id} onClick={() => deleteAdminDesign(design)}><Trash2 size={14}/> {adminDeleteBusyId === design.id ? "Deleting…" : "Delete"}</button>
                              </div>
                            </div>
                          </article>
                        ))}
                        {pagedAdminDesigns.length === 0 && <p>No designs match those filters.</p>}
                      </div>
                      <div className="admin-design-pagination">
                        <span>Page {adminDesignPage} of {adminDesignPageCount} · {sortedAdminDesigns.length} designs</span>
                        <button className="button button-quiet" type="button" disabled={adminDesignPage <= 1} onClick={() => setAdminDesignPage((page) => page - 1)}>Previous</button>
                        <button className="button button-quiet" type="button" disabled={adminDesignPage >= adminDesignPageCount} onClick={() => setAdminDesignPage((page) => page + 1)}>Next</button>
                      </div>
                      </>
                    )}
                  </section>
                )}
              </>
            )}
            {adminDesignEdit && isVerifiedSuperAdmin && (
              <div className="auth-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !adminDesignEditBusy) setAdminDesignEdit(null); }}>
                <section className="auth-dialog admin-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-edit-title">
                  <button className="auth-close" type="button" aria-label="Close edit form" disabled={adminDesignEditBusy} onClick={closeAdminDesignEdit}><X size={20}/></button>
                  <div className="eyebrow">DESIGN MANAGEMENT</div>
                  <h2 id="admin-edit-title">Edit design details</h2>
                  <form className="admin-upload-form" onSubmit={saveAdminDesignEdit}>
                    <label>Design name <span aria-hidden="true">*</span><input required maxLength={200} value={adminDesignEdit.name} onChange={(event) => setAdminDesignEdit((current) => ({ ...current, name: event.target.value }))}/></label>
                    <label>Serial number<input maxLength={200} value={adminDesignEdit.serialNumber} onChange={(event) => setAdminDesignEdit((current) => ({ ...current, serialNumber: event.target.value }))}/></label>
                    <label>Category <span aria-hidden="true">*</span>
                      <select required value={adminDesignEdit.categoryId} onChange={(event) => setAdminDesignEdit((current) => ({ ...current, categoryId: event.target.value }))}>
                        <option value="" disabled>Select a category</option>
                        {designCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                    </label>
                    <label>Description<textarea rows="4" maxLength={5000} value={adminDesignEdit.description} onChange={(event) => setAdminDesignEdit((current) => ({ ...current, description: event.target.value }))}/></label>
                    <label>Keywords <small>Separate keywords with commas or new lines.</small><textarea rows="3" value={adminDesignEdit.keywords} onChange={(event) => setAdminDesignEdit((current) => ({ ...current, keywords: event.target.value }))}/></label>
                    <label className="admin-image-field">Add design files<input type="file" accept={ACCEPTED_DESIGN_EXTENSIONS} multiple disabled={adminDesignEditBusy} onChange={(event) => handleDesignFilesChange(event, true)}/><small>Up to {MAX_DESIGN_FILE_COUNT} files per design, {formatFileSize(MAX_DESIGN_FILE_SIZE)} each. Existing files are kept.</small>
                      {adminDesignEdit.files.map(({ file, previewUrl }, index) => {
                        const FileIcon = ["zip", "rar"].includes(getDesignFileExtension(file.name)) ? FileArchive : FileText;
                        const progress = uploadProgress[index];
                        return (
                          <div className="design-upload-file" key={`${file.name}-${file.lastModified}-${index}`}>
                            {previewUrl ? <img src={previewUrl} alt=""/> : <span className="design-upload-file-icon"><FileIcon size={20}/></span>}
                            <div className="design-upload-file-info">
                              <strong title={file.name}>{file.name}</strong>
                              <span>.{getDesignFileExtension(file.name)} · {formatFileSize(file.size)}</span>
                              {progress && <><progress max="100" value={progress.percent}/><span role="status">{progress.status} · {progress.percent}%</span></>}
                            </div>
                          </div>
                        );
                      })}
                    </label>
                    <label className="admin-image-field">Replace customer-facing preview<input type="file" accept={ACCEPTED_PREVIEW_EXTENSIONS} disabled={adminDesignEditBusy} onChange={(event) => setAdminDesignEdit((current) => ({ ...current, previewFile: event.target.files?.[0] || null }))}/><small>Optional. The selected image will be downscaled and watermarked; original files remain unchanged.</small>{adminDesignEdit.previewFile && <small>Selected preview: {adminDesignEdit.previewFile.name} · {formatFileSize(adminDesignEdit.previewFile.size)}</small>}</label>
                    {adminDesignActionError && <p className="auth-feedback auth-error" role="alert">{adminDesignActionError}</p>}
                    <div className="profile-edit-actions">
                      <button className="button button-primary" type="submit" disabled={adminDesignEditBusy}>{adminDesignEditBusy ? "Saving…" : "Save Changes"}</button>
                      <button className="button button-quiet" type="button" disabled={adminDesignEditBusy} onClick={closeAdminDesignEdit}>Cancel</button>
                    </div>
                  </form>
                </section>
              </div>
            )}
          </section>
        ) : isDashboardRoute ? (
          <section className="customer-dashboard section">
            {isProfileCheckPending && (
              <div className="dashboard-message" role="status">Verifying your customer account…</div>
            )}
            {profileStatus === "signed_out" && !user && (
              <div className="dashboard-message">
                <h1>Customer dashboard</h1>
                <p>Please log in with your customer account to continue.</p>
                <button className="button button-primary" type="button" onClick={() => openAuth("login")}>Log in</button>
              </div>
            )}
            {profileStatus === "denied" && (
              <div className="dashboard-message" role="alert">
                <h1>Customer access only</h1>
                <p>This dashboard is available only to accounts with the public_user role.</p>
                <a className="button button-quiet" href="/#home">Return to home</a>
              </div>
            )}
            {isVerifiedSuperAdmin && (
              <div className="dashboard-message" role="alert">
                <h1>Super Admin dashboard</h1>
                <p>Your account uses the separate Super Admin dashboard.</p>
                <a className="button button-primary" href="/super-admin">Open Super Admin Dashboard</a>
              </div>
            )}
            {profileStatus === "error" && (
              <div className="dashboard-message" role="alert">
                <h1>Unable to load your account</h1>
                <p>{profileError}</p>
                <button className="button button-primary" type="button" onClick={() => setProfileRefresh((value) => value + 1)}>Try again</button>
              </div>
            )}
            {isVerifiedCustomer && customerProfile && (
              <>
                <div className="dashboard-welcome">
                  <div>
                    <div className="eyebrow">CUSTOMER DASHBOARD</div>
                    <h1>Welcome, {customerProfile.full_name || "there"}.</h1>
                    <p>Your SRI HARI DESIGNER account at a glance.</p>
                  </div>
                  <button className="button dashboard-logout" type="button" onClick={handleLogout}><LogOut size={16}/> Logout</button>
                </div>

                <div className="dashboard-grid">
                  <section className="dashboard-card profile-card">
                    <div className="dashboard-card-heading"><UserRound size={19}/><h2>My Profile</h2></div>
                    {profileEditing ? (
                      <form className="settings-form profile-edit-form" onSubmit={handleProfileSave}>
                        <label>
                          <span>Full name</span>
                          <input autoComplete="name" required maxLength={120} value={profileForm.fullName} onChange={(event) => setProfileForm((current) => ({ ...current, fullName: event.target.value }))} />
                        </label>
                        <label>
                          <span>Email (read only)</span>
                          <input type="email" value={customerProfile.email || ""} readOnly aria-readonly="true" />
                        </label>
                        <label>
                          <span>Phone number</span>
                          <input type="tel" autoComplete="tel" maxLength={40} value={profileForm.phone} onChange={(event) => setProfileForm((current) => ({ ...current, phone: event.target.value }))} />
                        </label>
                        {profileSaveError && <p className="auth-feedback auth-error" role="alert">{profileSaveError}</p>}
                        <div className="profile-edit-actions">
                          <button className="button button-primary" type="submit" disabled={profileSaveBusy}>{profileSaveBusy ? "Saving…" : "Save Changes"}</button>
                          <button className="button button-quiet" type="button" onClick={cancelProfileEdit} disabled={profileSaveBusy}>Cancel</button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <dl className="profile-details">
                          <div><dt>Full name</dt><dd>{customerProfile.full_name || "Not provided"}</dd></div>
                          <div><dt>Email</dt><dd>{customerProfile.email || "Not provided"}</dd></div>
                          <div><dt>Phone</dt><dd>{customerProfile.phone || "Not provided"}</dd></div>
                        </dl>
                        <div className="profile-edit-actions">
                          <button className="button button-primary" type="button" onClick={beginProfileEdit}>Edit Profile</button>
                          {profileSaveMessage && <p className="auth-feedback auth-success" role="status">{profileSaveMessage}</p>}
                        </div>
                      </>
                    )}
                  </section>

                  <section className="dashboard-card browse-card dashboard-gallery-card">
                    <div className="dashboard-card-heading"><ImageIcon size={19}/><h2>Browse Designs</h2></div>
                    <p>Explore published designs by category or search by name and serial number.</p>
                    {designImageWarning && <p className="auth-feedback auth-error design-image-warning" role="alert">{designImageWarning}</p>}
                    {designLoadStatus === "loading" && <div className="empty-state design-empty" role="status"><p>Loading designs…</p></div>}
                    {designLoadStatus === "error" && (
                      <div className="empty-state design-empty" role="alert">
                        <h3>Designs could not be loaded</h3>
                        <p>{designLoadError}</p>
                        <button className="text-button" type="button" onClick={() => setDesignRefresh((value) => value + 1)}>Try again</button>
                      </div>
                    )}
                    {designLoadStatus === "loaded" && (
                      <>
                        <div className="design-browser-controls">
                          <label className="design-search">
                            <Search size={18}/>
                            <input value={designSearch} onChange={(event) => setDesignSearch(event.target.value)} placeholder="Search name or serial number…" aria-label="Search designs by name or serial number" />
                          </label>
                          <div className="category-list" aria-label="Filter designs by category">
                            <button type="button" onClick={() => setDesignCategoryId("all")} className={designCategoryId === "all" ? "category active" : "category"}>All designs</button>
                            {designCategories.map((item) => (
                              <button type="button" key={item.id} onClick={() => setDesignCategoryId(item.id)} className={designCategoryId === item.id ? "category active" : "category"}>{item.name}</button>
                            ))}
                          </div>
                        </div>
                        {designItems.length === 0 ? (
                          <div className="empty-state design-empty">
                            <div className="empty-icon"><ImageIcon size={25}/></div>
                            <h3>No designs available yet. Our collection is coming soon.</h3>
                          </div>
                        ) : filteredDesignItems.length === 0 ? (
                          <div className="empty-state design-empty">
                            <h3>No matching designs</h3>
                            <p>Try a different search or category.</p>
                          </div>
                        ) : (
                          <div className="design-gallery">
                            {filteredDesignItems.map((design) => {
                              const categoryName = designCategories.find((item) => item.id === design.category_id)?.name;
                              const isFavorite = favoriteDesignIds.includes(design.id);
                              return (
                                <article className="design-card dashboard-design-card" key={design.id}>
                                  <button className="design-card-open" type="button" onClick={() => setSelectedDesign(design)} aria-label={`View details for ${design.name}`}>
                                    <DesignPreview className="design-card-preview" url={design.imageUrl} name={design.imageName || design.name}/>
                                    <div className="design-meta"><span>{design.serial_number || "Design"}</span><ArrowUpRight size={15}/></div>
                                    {design.subBrand && <div className="design-subbrand-line"><SubBrandLogo subBrand={design.subBrand}/><span>{design.subBrand.name}</span></div>}
                                    <h3>{design.name}</h3>
                                    <p>{categoryName || "Category unavailable"}</p>
                                  </button>
                                  <button
                                    className={isFavorite ? "favorite-toggle active" : "favorite-toggle"}
                                    type="button"
                                    aria-label={isFavorite ? `Remove ${design.name} from favourites` : `Add ${design.name} to favourites`}
                                    aria-pressed={isFavorite}
                                    disabled={favoriteBusyId === design.id || favoritesStatus !== "loaded"}
                                    onClick={(event) => { event.stopPropagation(); void toggleFavorite(design.id); }}
                                  >
                                    <Heart size={17} fill={isFavorite ? "currentColor" : "none"} />
                                  </button>
                                  <span className="design-like-count">{favoriteCountError ? "—" : favoriteCounts[design.id] || 0}</span>
                                </article>
                              );
                            })}
                          </div>
                        )}
                      </>
                    )}
                  </section>

                  <section className="dashboard-card">
                    <div className="dashboard-card-heading"><Heart size={19}/><h2>My Favourites</h2></div>
                    {favoritesStatus === "loading" && <p role="status">Loading favourites…</p>}
                    {favoritesError && <p className="auth-feedback auth-error" role="alert">{favoritesError}</p>}
                    {favoritesStatus === "loaded" && favoriteDesignIds.length === 0 && <p>You have not saved any designs yet. Select the heart on a design to add it here.</p>}
                    {favoritesStatus === "loaded" && favoriteDesignIds.length > 0 && (
                      <div className="favorite-design-list">
                        {favoriteDesigns.map((design) => (
                          <article className="favorite-design-item" key={design.id}>
                            <DesignPreview url={design.imageUrl} name={design.imageName || design.name}/>
                            <div><strong>{design.name}</strong><span>{design.serial_number || "No serial number"}</span>{design.subBrand && <span className="design-subbrand-line"><SubBrandLogo subBrand={design.subBrand}/>{design.subBrand.name}</span>}</div>
                            <button
                              className="favorite-toggle active"
                              type="button"
                              aria-label={`Remove ${design.name} from favourites`}
                              disabled={favoriteBusyId === design.id}
                              onClick={() => toggleFavorite(design.id)}
                            >
                              <Heart size={17} fill="currentColor" />
                            </button>
                          </article>
                        ))}
                        {favoriteDesigns.length === 0 && <p>Saved designs are not currently published or available.</p>}
                      </div>
                    )}
                  </section>

                  <section className="dashboard-card settings-card">
                    <div className="dashboard-card-heading"><Settings size={19}/><h2>Account Settings</h2></div>
                    <p>Change your account password. Profile and role information are not editable here.</p>
                    <form className="settings-form" onSubmit={handleSettingsSubmit}>
                      <label>
                        <span><LockKeyhole size={15}/> New password</span>
                        <input type="password" autoComplete="new-password" minLength={6} required value={settingsPassword} onChange={(event) => setSettingsPassword(event.target.value)} />
                      </label>
                      <label>
                        <span><LockKeyhole size={15}/> Confirm new password</span>
                        <input type="password" autoComplete="new-password" minLength={6} required value={settingsConfirmPassword} onChange={(event) => setSettingsConfirmPassword(event.target.value)} />
                      </label>
                      {settingsError && <p className="auth-feedback auth-error" role="alert">{settingsError}</p>}
                      {settingsMessage && <p className="auth-feedback auth-success" role="status">{settingsMessage}</p>}
                      <button className="button button-primary" type="submit" disabled={settingsBusy}>{settingsBusy ? "Updating…" : "Update password"}</button>
                    </form>
                  </section>
                </div>
              </>
            )}
          </section>
        ) : (
          <>
        <section className="hero" id="home">
          <div className="hero-content">
            <div className="eyebrow"><span className="eyebrow-line" /> YOUR TEXTILE DESIGN DESTINATION</div>
            <h1>Discover designs.<br /><em>Create something</em> beautiful.</h1>
            <p>Explore the SRI HARI DESIGNER collection of textile patterns and creative designs. Find the design you need by name, category or serial number.</p>
            <div className="hero-actions">
              <a className="button button-primary" href="#designs">Explore designs <ArrowUpRight size={17}/></a>
              <a className="button button-quiet" href="#about">Know our brand</a>
            </div>
            <div className="hero-note"><ShieldCheck size={17}/> Original brand identity • Curated textile designs</div>
          </div>
          <div className="hero-mark">
            <div className="logo-frame"><img src="/brand-logo.jpeg" alt="SRI HARI DESIGNER brand mark" /></div>
            <span className="floating-label">SRI HARI DESIGNER</span>
            <span className="decor decor-one" /><span className="decor decor-two" />
          </div>
        </section>

        <section className="catalogue section" id="designs">
          <div className="section-heading">
            <div><div className="eyebrow">THE COLLECTION</div><h2>Find your next design</h2></div>
            <p>Search by design name, category or unique serial number.</p>
          </div>
          <div className="search-panel">
            <div className="search-input"><Search size={19}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search design name or serial number..." aria-label="Search designs" /></div>
            <div className="category-list" aria-label="Filter by category">
              <button onClick={() => setCategory("All designs")} className={category === "All designs" ? "category active" : "category"}>All designs</button>
              {publicCategories.map((item) => <button key={item.id} onClick={() => setCategory(item.name)} className={category === item.name ? "category active" : "category"}>{item.name}</button>)}
            </div>
          </div>
          {publicCategoryStatus === "loading" && <p role="status">Loading categories…</p>}
          {publicCategoryStatus === "error" && <p className="auth-feedback auth-error" role="alert">Categories could not be loaded: {publicCategoryError}</p>}
          {publicCategoryStatus === "loaded" && publicCategories.length === 0 && <p>No active categories are available yet.</p>}
          {publicCatalogueStatus === "loading" && <p role="status">Loading published designs…</p>}
          {publicCatalogueStatus === "error" && <p className="auth-feedback auth-error" role="alert">{publicCatalogueError}</p>}
          {publicCatalogueError && publicCatalogueStatus === "loaded" && <p className="design-image-warning" role="status">{publicCatalogueError}</p>}
          {publicCatalogueStatus === "loaded" && visibleDesigns.length > 0 && (
            <div className="design-grid">{visibleDesigns.map((item) => {
              const categoryName = publicCategories.find((entry) => entry.id === item.category_id)?.name || "Category unavailable";
              const isFavorite = favoriteDesignIds.includes(item.id);
              return <article className="design-card dashboard-design-card" key={item.id}>
                <button className="design-card-open" type="button" onClick={() => setSelectedDesign(item)} aria-label={`View details for ${item.name}`}>
                  <DesignPreview className="design-card-preview" url={item.imageUrl} name={item.imageName || item.name}/>
                  <div className="design-meta"><span>{item.serial_number || "Design"}</span><ArrowUpRight size={15}/></div>
                  {item.subBrand && <div className="design-subbrand-line"><SubBrandLogo subBrand={item.subBrand}/><span>{item.subBrand.name}</span></div>}
                  <h3>{item.name}</h3><p>{categoryName}</p>
                </button>
                <button className={isFavorite ? "favorite-toggle active" : "favorite-toggle"} type="button" aria-label={isFavorite ? `Unlike ${item.name}` : `Like ${item.name}`} aria-pressed={isFavorite} disabled={favoriteBusyId === item.id || (isVerifiedCustomer && favoritesStatus !== "loaded")} onClick={(event) => { event.stopPropagation(); void toggleFavorite(item.id); }}>
                  <Heart size={17} fill={isFavorite ? "currentColor" : "none"}/>
                </button>
                <span className="design-like-count">{favoriteCountError ? "—" : favoriteCounts[item.id] || 0}</span>
              </article>;
            })}</div>
          )}
          {publicCatalogueStatus === "loaded" && visibleDesigns.length === 0 && (
            <div className="empty-state">
              <div className="empty-icon"><ImageIcon size={29}/></div>
              <h3>{query || category !== "All designs" ? "No matching designs yet" : "Our design collection is being prepared"}</h3>
              <p>{query || category !== "All designs" ? "Try another design name, category or serial number." : "New textile designs will appear here after they are published by an authorised administrator."}</p>
              {(query || category !== "All designs") && <button className="text-button" onClick={() => {setQuery(""); setCategory("All designs");}}>Clear filters</button>}
            </div>
          )}
        </section>

        <section className="about section" id="about">
          <div className="about-logo"><img src="/brand-logo.jpeg" alt="Sri Hari Designer logo" /></div>
          <div className="about-copy"><div className="eyebrow">ABOUT OUR BRAND</div><h2>Design is at the heart of every creation.</h2><p>SRI HARI DESIGNER brings textile designs together in one easy-to-explore collection. Our website is being developed to help customers discover designs by category and unique design number.</p><div className="owner-lines"><span><b>Owner</b> SOUNDAPPAN R</span><span><b>Presented by</b> SOUNDAPPAN R</span></div></div>
        </section>
          </>
        )}
      </main>
      {selectedDesign && (
        <DesignDetailsDialog
          design={selectedDesign}
          categoryName={designCategories.find((item) => item.id === selectedDesign.category_id)?.name
            || publicCategories.find((item) => item.id === selectedDesign.category_id)?.name
            || "Category unavailable"}
          isFavorite={favoriteDesignIds.includes(selectedDesign.id)}
          likeCount={favoriteCounts[selectedDesign.id] || 0}
          likeCountError={favoriteCountError}
          likeBusy={favoriteBusyId === selectedDesign.id}
          likeDisabled={isVerifiedCustomer && favoritesStatus !== "loaded"}
          onClose={() => setSelectedDesign(null)}
          onToggleFavorite={() => void toggleFavorite(selectedDesign.id)}
        />
      )}

      <footer id="contact">
        <div className="footer-main">
          <div className="footer-brand"><img src="/brand-logo.jpeg" alt="Sri Hari Designer logo"/><div><strong>SRI HARI DESIGNER</strong><small>TEXTILE DESIGN COLLECTION</small></div><p>Discover textile designs with clarity, convenience and creativity.</p></div>
          <div className="footer-contact"><div className="eyebrow">GET IN TOUCH</div><a href="tel:9894046628"><Phone size={17}/> 9894046628 <span className="contact-note">Business / Customer contact / GPay</span></a><a href="mailto:sriharidesigner1983@gmail.com"><Mail size={17}/> sriharidesigner1983@gmail.com</a><a href="https://goo.gl/maps/pk33tmDkSBQdMGEA6?g_st=ac" target="_blank" rel="noreferrer"><MapPin size={17}/> View company location on Google Maps <ArrowUpRight size={14}/></a></div>
        </div>
        <div className="footer-bottom"><span>© {new Date().getFullYear()} SRI HARI DESIGNER. All rights reserved.</span><span>Owner: SOUNDAPPAN R · Presented by: SOUNDAPPAN R</span></div>
      </footer>
      {authOpen && (
        <div className="auth-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAuthOpen(false); }}>
          <section className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title">
            <button className="auth-close" type="button" aria-label="Close" onClick={() => setAuthOpen(false)}><X size={20}/></button>
            <div className="eyebrow">SRI HARI DESIGNER ACCOUNT</div>
            <h2 id="auth-title">{authMode === "register" ? "Create your account" : authMode === "forgot" ? "Reset your password" : authMode === "reset" ? "Choose a new password" : "Welcome back"}</h2>
            <p className="auth-intro">{authMode === "register" ? "Register to access your customer account." : authMode === "forgot" ? "Enter your account email and we will send a reset link." : authMode === "reset" ? "Enter and confirm your new password." : "Log in to your customer account."}</p>
            <form className="auth-form" onSubmit={handleAuthSubmit}>
              {authMode === "register" && (
                <>
                  <label>Full Name<input autoComplete="name" required value={authForm.fullName} onChange={setAuthField("fullName")} /></label>
                  <label>Phone<input type="tel" autoComplete="tel" required value={authForm.phone} onChange={setAuthField("phone")} /></label>
                </>
              )}
              {authMode !== "reset" && (
                <label>Email<input type="email" autoComplete="email" required value={authForm.email} onChange={setAuthField("email")} /></label>
              )}
              {(authMode === "login" || authMode === "register") && (
                <label>Password<input type="password" autoComplete={authMode === "register" ? "new-password" : "current-password"} minLength={6} required value={authForm.password} onChange={setAuthField("password")} /></label>
              )}
              {(authMode === "register" || authMode === "reset") && (
                <>
                  {authMode === "reset" && <label>New Password<input type="password" autoComplete="new-password" minLength={6} required value={authForm.password} onChange={setAuthField("password")} /></label>}
                  <label>Confirm Password<input type="password" autoComplete="new-password" minLength={6} required value={authForm.confirmPassword} onChange={setAuthField("confirmPassword")} /></label>
                </>
              )}
              {authError && <p className="auth-feedback auth-error" role="alert">{authError}</p>}
              {authMessage && <p className="auth-feedback auth-success" role="status">{authMessage}</p>}
              <button className="button button-primary auth-submit" type="submit" disabled={authBusy}>{authBusy ? "Please wait..." : authMode === "register" ? "Create account" : authMode === "forgot" ? "Send reset link" : authMode === "reset" ? "Update password" : "Log in"}</button>
            </form>
            <div className="auth-links">
              {authMode === "login" && <>
                <button type="button" onClick={() => openAuth("forgot")}>Forgot password?</button>
                <button type="button" onClick={() => openAuth("register")}>Create an account</button>
              </>}
              {authMode === "register" && <button type="button" onClick={() => openAuth("login")}>Already registered? Log in</button>}
              {authMode === "forgot" && <button type="button" onClick={() => openAuth("login")}>Back to login</button>}
              {authMode === "reset" && <button type="button" onClick={() => openAuth("login")}>Back to login</button>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
