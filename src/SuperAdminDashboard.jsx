import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BarChart3,
  Boxes,
  Image as ImageIcon,
  Layers3,
  Plus,
  RefreshCw,
  ShieldCheck,
  Users,
  Settings,
  Trash2,
} from "lucide-react";
import { fetchAllRows, supabase } from "./supabase.js";

const tabs = [
  { id: "overview", label: "Overview", icon: BarChart3 },
  { id: "designs", label: "Designs", icon: ImageIcon },
  { id: "add-design", label: "Add Design", icon: Plus },
  { id: "categories", label: "Categories", icon: Layers3 },
  { id: "sub-brands", label: "Sub-Brands", icon: Boxes },
  { id: "customers", label: "Customers", icon: Users },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
  { id: "activity", label: "Activity Logs", icon: Activity },
  { id: "settings", label: "Settings", icon: Settings },
];

async function loadDesignRows() {
  const buildQuery = (includePreviewPath) => supabase
    .from("designs")
    .select(`id, serial_number, name, description, keywords, category_id, ${includePreviewPath ? "preview_path, " : ""}uploaded_by, sub_brand_id, is_published, created_at`)
    .order("created_at", { ascending: false })
    .order("id");
  try {
    return await fetchAllRows(() => buildQuery(true));
  } catch (error) {
    if (!/column designs\.preview_path does not exist|preview_path.*schema cache/i.test(error.message || "")) throw error;
    return fetchAllRows(() => buildQuery(false));
  }
}

const emptyCategoryForm = { id: "", name: "", description: "", is_active: true };
const emptySubBrandForm = {
  id: "",
  name: "",
  contactPerson: "",
  contactPhone: "",
  contactEmail: "",
  address: "",
  locationUrl: "",
  logoFile: null,
  logoPath: null,
};

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function getErrorMessage(error, fallback) {
  if (error?.code === "23505") return "A record with this unique value already exists.";
  if (error && typeof error.message === "string" && error.message.trim()) return error.message;
  return error instanceof Error ? error.message : fallback;
}

export default function SuperAdminDashboard({ profile, onLogout }) {
  const [activeTab, setActiveTab] = useState("overview");
  const [profiles, setProfiles] = useState([]);
  const [categories, setCategories] = useState([]);
  const [subBrands, setSubBrands] = useState([]);
  const [designs, setDesigns] = useState([]);
  const [activityLogs, setActivityLogs] = useState([]);
  const [designViews, setDesignViews] = useState([]);
  const [loadStatus, setLoadStatus] = useState("loading");
  const [loadError, setLoadError] = useState("");
  const [imageWarning, setImageWarning] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [categoryForm, setCategoryForm] = useState(emptyCategoryForm);
  const [subBrandForm, setSubBrandForm] = useState(emptySubBrandForm);
  const [customerSearch, setCustomerSearch] = useState("");
  const [schemaNotice, setSchemaNotice] = useState("");
  const [categoryLoadError, setCategoryLoadError] = useState("");
  const [categoryLoadStatus, setCategoryLoadStatus] = useState("loading");
  const [subBrandLogoPreview, setSubBrandLogoPreview] = useState("");
  const subBrandLogoInputRef = useRef(null);

  useEffect(() => {
    if (!subBrandForm.logoFile) {
      setSubBrandLogoPreview("");
      return undefined;
    }
    const preview = URL.createObjectURL(subBrandForm.logoFile);
    setSubBrandLogoPreview(preview);
    return () => URL.revokeObjectURL(preview);
  }, [subBrandForm.logoFile]);

  useEffect(() => {
    let active = true;
    setLoadStatus("loading");
    setLoadError("");
    setImageWarning("");

    const loadDashboard = async () => {
      const [
        profileRows,
        categoryResult,
        subBrandResult,
        designRows,
        { data: activityRows, error: activityError },
        { data: viewRows, error: viewError },
      ] = await Promise.all([
        fetchAllRows(() => supabase
          .from("profiles")
          .select("id, full_name, email, phone, role, is_active, created_at")
          .order("created_at", { ascending: false })
          .order("id")),
        fetchAllRows(() => supabase
          .from("categories")
          .select("id, name, description, is_active, created_at")
          .order("name")
          .order("id"))
          .then((rows) => ({ rows, error: "" }))
          .catch((error) => ({ rows: [], error: `Categories could not be loaded: ${error.message}` })),
        (async () => {
          const full = await fetchAllRows(() => supabase
            .from("sub_brands")
            .select("id, name, contact_person, contact_phone, contact_email, address, location_url, logo_path, admin_user_id, is_active, created_at")
            .order("name")
            .order("id"))
            .then((rows) => ({ rows, migrationMissing: false }))
            .catch(async (error) => {
              if (!/column .* does not exist|could not find .* column/i.test(error.message)) throw error;
              const rows = await fetchAllRows(() => supabase
                .from("sub_brands")
                .select("id, name, contact_phone, contact_email, location_url, logo_path, admin_user_id, is_active, created_at")
                .order("name")
                .order("id"));
              return { rows, migrationMissing: true };
            });
          return full;
        })(),
        loadDesignRows(),
        supabase
          .from("activity_logs")
          .select("id, actor_id, action, target_type, target_id, details, created_at")
          .order("created_at", { ascending: false })
          .order("id")
          .limit(200),
        supabase
          .from("design_views")
          .select("id, design_id, viewer_id, viewed_at")
          .order("viewed_at", { ascending: false })
          .order("id")
          .limit(200),
      ]);

      if (activityError) throw new Error(`Activity logs could not be loaded: ${activityError.message}`);
      if (viewError) throw new Error(`Design views could not be loaded: ${viewError.message}`);

      const imageWarnings = [];
      const subBrandRows = await Promise.all(subBrandResult.rows.map(async (item) => {
        if (!item.logo_path) return { ...item, logoUrl: null };
        let { data, error } = await supabase.storage
          .from("sub-brand-logos")
          .createSignedUrl(item.logo_path, 60 * 60);
        if (error) {
          const fallback = await supabase.storage.from("design-images").createSignedUrl(item.logo_path, 60 * 60);
          data = fallback.data;
          error = fallback.error;
        }
        if (error) {
          imageWarnings.push(`Sub-brand logo could not be opened from either private image bucket: ${error.message}`);
          return { ...item, logoUrl: null };
        }
        return { ...item, logoUrl: data.signedUrl };
      }));

      const designRowsWithImages = [];
      for (let offset = 0; offset < designRows.length; offset += 25) {
        const batch = await Promise.all(designRows.slice(offset, offset + 25).map(async (design) => {
          if (!design.preview_path) return { ...design, imageUrl: null };
          const { data, error } = await supabase.storage
            .from("design-previews")
            .createSignedUrl(design.preview_path, 10 * 60);
          if (error) {
            imageWarnings.push(error.message);
            return { ...design, imageUrl: null };
          }
          return { ...design, imageUrl: data.signedUrl };
        }));
        designRowsWithImages.push(...batch);
      }

      if (!active) return;
      setProfiles(profileRows);
      setCategories(categoryResult.rows);
      setCategoryLoadError(categoryResult.error);
      setCategoryLoadStatus(categoryResult.error ? "error" : "loaded");
      setSubBrands(subBrandRows);
      setSchemaNotice(subBrandResult.migrationMissing
        ? "Sub-brand logo, contact person, and address fields require the prepared migration before editing those details."
        : "");
      setDesigns(designRowsWithImages);
      setActivityLogs(activityRows || []);
      setDesignViews(viewRows || []);
      setImageWarning(imageWarnings.length
        ? `Some private design images could not be opened: ${imageWarnings[0]}`
        : "");
      setLoadStatus("loaded");
    };

    loadDashboard().catch((error) => {
      if (!active) return;
      setLoadError(getErrorMessage(error, "The Super Admin dashboard could not be loaded."));
      setLoadStatus("error");
    });

    return () => {
      active = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (activeTab !== "categories") return undefined;
    let active = true;
    setCategoryLoadStatus("loading");
    setCategoryLoadError("");

    fetchAllRows(() => supabase
      .from("categories")
      .select("id, name, description, is_active, created_at")
      .order("name")
      .order("id"))
      .then((rows) => {
        if (!active) return;
        setCategories(rows);
        setCategoryLoadStatus("loaded");
      })
      .catch((error) => {
        if (!active) return;
        setCategoryLoadError(`Categories could not be loaded: ${getErrorMessage(error, "Unknown database error.")}`);
        setCategoryLoadStatus("error");
      });

    return () => {
      active = false;
    };
  }, [activeTab, refresh]);

  const customers = useMemo(() => profiles.filter((item) => item.role === "public_user"), [profiles]);
  const filteredCustomers = useMemo(() => {
    const term = customerSearch.trim().toLocaleLowerCase();
    return customers.filter((customer) => !term || [
      customer.full_name,
      customer.email,
      customer.phone,
    ].some((value) => String(value || "").toLocaleLowerCase().includes(term)));
  }, [customers, customerSearch]);
  const profileNames = useMemo(
    () => new Map(profiles.map((item) => [item.id, item.full_name?.trim() || "Account"])),
    [profiles],
  );
  const designNames = useMemo(
    () => new Map(designs.map((item) => [item.id, item.name])),
    [designs],
  );

  const resetActionFeedback = () => {
    setActionError("");
    setActionMessage("");
  };

  const reload = () => setRefresh((value) => value + 1);

  const saveCategory = async (event) => {
    event.preventDefault();
    resetActionFeedback();
    setActionBusy(true);
    try {
      const values = {
        name: categoryForm.name.trim(),
        description: categoryForm.description.trim() || null,
        is_active: categoryForm.is_active,
      };
      if (!values.name) throw new Error("Enter a category name.");
      if (categories.some((item) => item.id !== categoryForm.id && item.name.trim().toLocaleLowerCase() === values.name.toLocaleLowerCase())) {
        throw new Error("A category with this name already exists.");
      }
      if (categoryForm.id) {
        const { data, error } = await supabase
          .from("categories")
          .update(values)
          .eq("id", categoryForm.id)
          .select("id")
          .maybeSingle();
        if (error) throw error;
        if (!data) throw new Error("The category could not be updated under the current permissions.");
        setActionMessage("Category updated.");
      } else {
        const { data, error } = await supabase.from("categories").insert(values).select("id").single();
        if (error) throw error;
        if (!data?.id) throw new Error("Supabase did not confirm the new category.");
        setActionMessage("Category added.");
      }
      setCategoryForm(emptyCategoryForm);
      reload();
    } catch (error) {
      setActionError(getErrorMessage(error, "The category could not be saved."));
    } finally {
      setActionBusy(false);
    }
  };

  const setCategoryActive = async (item, isActive) => {
    resetActionFeedback();
    try {
      const { data, error } = await supabase
        .from("categories")
        .update({ is_active: isActive })
        .eq("id", item.id)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("The category status could not be changed under the current permissions.");
      setActionMessage(isActive ? "Category activated." : "Category deactivated.");
      reload();
    } catch (error) {
      setActionError(getErrorMessage(error, "The category status could not be changed."));
    }
  };

  const deleteCategory = async (item) => {
    if (!window.confirm(`Delete category "${item.name}"? Categories with linked designs cannot be deleted.`)) return;
    resetActionFeedback();
    setActionBusy(true);
    try {
      const { count, error: countError } = await supabase
        .from("designs")
        .select("id", { count: "exact", head: true })
        .eq("category_id", item.id);
      if (countError) throw new Error(`Linked designs could not be checked: ${countError.message}`);
      if (!Number.isInteger(count)) throw new Error("The number of linked designs could not be verified, so this category was not deleted.");
      if (count > 0) throw new Error(`This category is linked to ${count} design${count === 1 ? "" : "s"}. Deactivate it instead to preserve those relationships.`);

      const { data, error } = await supabase
        .from("categories")
        .delete()
        .eq("id", item.id)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("The category was not deleted under the current database permissions.");
      setCategories((current) => current.filter((category) => category.id !== item.id));
      setActionMessage("Category deleted.");
      reload();
    } catch (error) {
      setActionError(getErrorMessage(error, "The category could not be deleted."));
    } finally {
      setActionBusy(false);
    }
  };

  const setCustomerActive = async (customer, isActive) => {
    resetActionFeedback();
    setActionBusy(true);
    try {
      const { data: { user: authenticatedUser }, error: authError } = await supabase.auth.getUser();
      if (authError) throw authError;
      if (!authenticatedUser || authenticatedUser.id !== profile?.id) {
        throw new Error("Your Super Admin session could not be verified. Sign in again.");
      }

      const { data, error } = await supabase
        .from("profiles")
        .update({ is_active: isActive })
        .eq("id", customer.id)
        .eq("role", "public_user")
        .select("id, is_active")
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("Customer status could not be changed under the current database permissions.");
      setProfiles((current) => current.map((item) => item.id === customer.id ? { ...item, is_active: data.is_active } : item));
      setActionMessage(isActive ? "Customer account activated." : "Customer account deactivated.");
    } catch (error) {
      setActionError(getErrorMessage(error, "Customer status could not be changed."));
    } finally {
      setActionBusy(false);
    }
  };

  const saveSubBrand = async (event) => {
    event.preventDefault();
    resetActionFeedback();
    setActionBusy(true);
    let uploadedLogoPath = null;
    try {
      const { data: { user: authenticatedUser }, error: authError } = await supabase.auth.getUser();
      if (authError) throw authError;
      if (!authenticatedUser || authenticatedUser.id !== profile?.id) {
        throw new Error("Your Super Admin session could not be verified. Sign in again.");
      }
      if (subBrands.some((item) => item.id !== subBrandForm.id && item.name.trim().toLocaleLowerCase() === subBrandForm.name.trim().toLocaleLowerCase())) {
        throw new Error("A sub-brand with this name already exists.");
      }
      if (subBrandForm.logoFile) {
        if (!["image/jpeg", "image/png", "image/webp"].includes(subBrandForm.logoFile.type)) {
          throw new Error("Choose a JPEG, PNG, or WebP logo.");
        }
        if (subBrandForm.logoFile.size > 2 * 1024 * 1024) {
          throw new Error("Choose a logo no larger than 2 MiB.");
        }
        const safeName = subBrandForm.logoFile.name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "") || "logo";
        uploadedLogoPath = `sub-brands/${authenticatedUser.id}/${crypto.randomUUID()}-${safeName}`;
        const { error: uploadError } = await supabase.storage
          .from("sub-brand-logos")
          .upload(uploadedLogoPath, subBrandForm.logoFile, {
            cacheControl: "3600",
            contentType: subBrandForm.logoFile.type,
            upsert: false,
          });
        if (uploadError) throw new Error(`Logo upload failed: ${uploadError.message}`);
      }

      const values = {
        name: subBrandForm.name.trim(),
        contact_person: subBrandForm.contactPerson.trim() || null,
        contact_phone: subBrandForm.contactPhone.trim() || null,
        contact_email: subBrandForm.contactEmail.trim() || null,
        address: subBrandForm.address.trim() || null,
        location_url: subBrandForm.locationUrl.trim() || null,
        logo_path: uploadedLogoPath || subBrandForm.logoPath || null,
      };
      if (subBrandForm.id) {
        const { data, error } = await supabase
          .from("sub_brands")
          .update(values)
          .eq("id", subBrandForm.id)
          .select("id")
          .maybeSingle();
        if (error) throw error;
        if (!data) throw new Error("The sub-brand could not be updated under the current permissions.");
        const oldLogoPath = subBrands.find((item) => item.id === subBrandForm.id)?.logo_path;
        if (uploadedLogoPath && oldLogoPath) {
          const { error: cleanupError } = await supabase.storage.from("sub-brand-logos").remove([oldLogoPath]);
          if (cleanupError) {
            setActionError(`Sub-brand saved, but the previous logo could not be removed: ${cleanupError.message}`);
          }
        }
        setActionMessage("Sub-brand updated.");
      } else {
        const { error } = await supabase.from("sub_brands").insert(values);
        if (error) throw error;
        setActionMessage("Sub-brand added.");
      }
      setSubBrandForm(emptySubBrandForm);
      if (subBrandLogoInputRef.current) subBrandLogoInputRef.current.value = "";
      reload();
    } catch (error) {
      setActionError(getErrorMessage(error, "The sub-brand could not be saved."));
      if (uploadedLogoPath) {
        const { error: cleanupError } = await supabase.storage.from("sub-brand-logos").remove([uploadedLogoPath]);
        if (cleanupError) {
          setActionError((message) => `${message} The uploaded logo could not be removed: ${cleanupError.message}`);
        }
      }
    } finally {
      setActionBusy(false);
    }
  };

  const setSubBrandActive = async (item, isActive) => {
    resetActionFeedback();
    try {
      const { data, error } = await supabase
        .from("sub_brands")
        .update({ is_active: isActive })
        .eq("id", item.id)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("The sub-brand status could not be changed under the current permissions.");
      setActionMessage(isActive ? "Sub-brand activated." : "Sub-brand deactivated.");
      reload();
    } catch (error) {
      setActionError(getErrorMessage(error, "The sub-brand status could not be changed."));
    }
  };

  const editCategory = (item) => {
    resetActionFeedback();
    setCategoryForm({
      id: item.id,
      name: item.name,
      description: item.description || "",
      is_active: item.is_active === true,
    });
    setActiveTab("categories");
  };

  const editSubBrand = (item) => {
    resetActionFeedback();
    setSubBrandForm({
      id: item.id,
      name: item.name,
      contactPerson: item.contact_person || "",
      contactPhone: item.contact_phone || "",
      contactEmail: item.contact_email || "",
      address: item.address || "",
      locationUrl: item.location_url || "",
      logoFile: null,
      logoPath: item.logo_path || null,
    });
    setActiveTab("sub-brands");
  };

  const publishedDesigns = designs.filter((item) => item.is_published).length;

  return (
    <div className="super-admin-page">
      <div className="dashboard-welcome">
        <div>
          <div className="eyebrow"><ShieldCheck size={14} /> SUPER ADMIN CONTROL</div>
          <h1>Dashboard</h1>
          <p>{profile?.full_name?.trim() || "Super Admin"} · Manage the catalogue and accounts</p>
        </div>
        <div className="super-admin-actions">
          <button className="button button-quiet" type="button" onClick={reload}><RefreshCw size={15} /> Refresh</button>
          <button className="button dashboard-logout" type="button" onClick={onLogout}>Log out</button>
        </div>
      </div>

      <nav className="super-admin-tabs" aria-label="Super Admin sections">
        {tabs.map(({ id, label, icon: Icon }) => id === "add-design" ? (
          <a className="super-admin-tab" key={id} href="/super-admin/add-design">
            <Icon size={16} /> {label}
          </a>
        ) : (
          <button
            type="button"
            key={id}
            className={activeTab === id ? "super-admin-tab active" : "super-admin-tab"}
            aria-current={activeTab === id ? "page" : undefined}
            onClick={() => { setActiveTab(id); resetActionFeedback(); }}
          >
            <Icon size={16} /> {label}
          </button>
        ))}
      </nav>

      {actionError && <p className="auth-feedback auth-error" role="alert">{actionError}</p>}
      {actionMessage && <p className="auth-feedback auth-success" role="status">{actionMessage}</p>}
      {imageWarning && <p className="auth-feedback auth-error" role="alert">{imageWarning}</p>}
      {schemaNotice && <p className="auth-feedback auth-error" role="alert">{schemaNotice}</p>}

      {loadStatus === "loading" && <div className="dashboard-message" role="status">Loading Super Admin data…</div>}
      {loadStatus === "error" && (
        <div className="dashboard-message" role="alert">
          <h2>Dashboard data could not be loaded</h2>
          <p>{loadError}</p>
          <button className="button button-primary" type="button" onClick={reload}>Try again</button>
        </div>
      )}

      {loadStatus === "loaded" && activeTab === "overview" && (
        <div className="super-admin-stat-grid">
          <StatCard label="Total users" value={profiles.length} icon={Users} />
          <StatCard label="Customer accounts" value={customers.length} icon={Users} />
          <StatCard label="Active categories" value={categories.filter((item) => item.is_active).length} icon={Layers3} />
          <StatCard label="Active sub-brands" value={subBrands.filter((item) => item.is_active).length} icon={Boxes} />
          <StatCard label="Published designs" value={`${publishedDesigns} / ${designs.length}`} icon={ImageIcon} />
          <StatCard label="Recent design views" value={designViews.length} icon={Activity} />
          <section className="dashboard-card super-admin-summary">
            <div className="dashboard-card-heading"><Users size={19} /><h2>Account summary</h2></div>
            <p>{customers.length} customer accounts · {subBrands.length} sub-brands</p>
            <button type="button" className="text-button" onClick={() => setActiveTab("customers")}>Manage customers</button>
          </section>
          <section className="dashboard-card super-admin-summary">
            <div className="dashboard-card-heading"><Activity size={19} /><h2>Recent activity</h2></div>
            {activityLogs.slice(0, 5).length ? (
              <ul className="super-admin-activity-list">
                {activityLogs.slice(0, 5).map((item) => (
                  <li key={item.id}>
                    <strong>{item.action}</strong>
                    <span>{profileNames.get(item.actor_id) || "System"} · {formatDate(item.created_at)}</span>
                  </li>
                ))}
              </ul>
            ) : <p>No activity has been recorded yet.</p>}
            <button type="button" className="text-button" onClick={() => setActiveTab("activity")}>View activity</button>
          </section>
        </div>
      )}

      {loadStatus === "loaded" && activeTab === "customers" && (
        <section className="dashboard-card super-admin-wide">
          <div className="dashboard-card-heading"><Users size={19} /><h2>Customers</h2></div>
          <label className="super-admin-search">Search customers<input type="search" placeholder="Name, email, or phone" value={customerSearch} onChange={(event) => setCustomerSearch(event.target.value)} /></label>
          {customers.length === 0 ? <p>No customer accounts found.</p> : filteredCustomers.length === 0 ? <p>No customers match this search.</p> : (
            <div className="super-admin-table-wrap">
              <table className="super-admin-table">
                <thead><tr><th>Customer</th><th>Phone</th><th>Status</th><th>Created</th><th>Account</th></tr></thead>
                <tbody>
                  {filteredCustomers.map((customer) => (
                    <tr key={customer.id}>
                      <td><strong>{customer.full_name || "Customer"}</strong><small>{customer.email || "Email unavailable"}</small></td>
                      <td>{customer.phone || "—"}</td>
                      <td><span className={customer.is_active ? "status-pill active" : "status-pill inactive"}>{customer.is_active ? "Active" : "Inactive"}</span></td>
                      <td>{formatDate(customer.created_at)}</td>
                      <td>
                        <button
                          type="button"
                          className="text-button"
                          disabled={actionBusy}
                          onClick={() => setCustomerActive(customer, !customer.is_active)}
                        >
                          {actionBusy ? "Saving…" : customer.is_active ? "Deactivate" : "Activate"}
                        </button>
                        <details>
                          <summary>View details and activity</summary>
                          <span>Account ID: {customer.id} · Created {formatDate(customer.created_at)}</span>
                          <ul>
                            {activityLogs.filter((item) => item.actor_id === customer.id).slice(0, 5).map((item) => (
                              <li key={item.id}>{item.action} · {formatDate(item.created_at)}</li>
                            ))}
                            {!activityLogs.some((item) => item.actor_id === customer.id) && <li>No recent activity is available.</li>}
                          </ul>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {loadStatus === "loaded" && activeTab === "categories" && (
        <div className="super-admin-grid">
          <section className="dashboard-card">
            <div className="dashboard-card-heading"><Layers3 size={19} /><h2>{categoryForm.id ? "Edit category" : "Add category"}</h2></div>
            <form className="super-admin-form" onSubmit={saveCategory}>
              <label>Name<input required maxLength={120} value={categoryForm.name} onChange={(event) => setCategoryForm((form) => ({ ...form, name: event.target.value }))} /></label>
              <label>Description<textarea rows="3" maxLength={1000} value={categoryForm.description} onChange={(event) => setCategoryForm((form) => ({ ...form, description: event.target.value }))} /></label>
              <label>Status<select value={categoryForm.is_active ? "active" : "inactive"} onChange={(event) => setCategoryForm((form) => ({ ...form, is_active: event.target.value === "active" }))}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
              <div className="super-admin-form-actions">
                <button className="button button-primary" type="submit" disabled={actionBusy || Boolean(categoryLoadError)}>{actionBusy ? "Saving…" : categoryForm.id ? "Save changes" : "Add category"}</button>
                {categoryForm.id && <button className="button button-quiet" type="button" onClick={() => setCategoryForm(emptyCategoryForm)}>Cancel</button>}
              </div>
            </form>
          </section>
          <section className="dashboard-card super-admin-wide">
            <div className="dashboard-card-heading"><Layers3 size={19} /><h2>Categories</h2></div>
            {categoryLoadStatus === "loading" && <p role="status">Loading categories…</p>}
            {categoryLoadError && <p className="auth-feedback auth-error" role="alert">{categoryLoadError}</p>}
            {categoryLoadStatus === "error" && <button className="text-button" type="button" onClick={reload}>Try loading categories again</button>}
            <div className="super-admin-record-list">
              {categories.map((item) => (
                <article className="super-admin-record" key={item.id}>
                  <div><strong>{item.name}</strong><p>{item.description || "No description"}</p><span className={item.is_active ? "status-pill active" : "status-pill inactive"}>{item.is_active ? "Active" : "Inactive"}</span></div>
                  <div className="super-admin-record-actions">
                    <button className="text-button" type="button" onClick={() => editCategory(item)}>Edit</button>
                    <button className="text-button" type="button" onClick={() => setCategoryActive(item, !item.is_active)}>{item.is_active ? "Deactivate" : "Activate"}</button>
                    <button className="text-button danger-text" type="button" disabled={actionBusy} onClick={() => deleteCategory(item)}><Trash2 size={14} /> Delete</button>
                  </div>
                </article>
              ))}
              {categoryLoadStatus === "loaded" && categories.length === 0 && <p>No categories found.</p>}
            </div>
          </section>
        </div>
      )}

      {loadStatus === "loaded" && activeTab === "sub-brands" && (
        <div className="super-admin-grid">
          <section className="dashboard-card">
            <div className="dashboard-card-heading"><Boxes size={19} /><h2>{subBrandForm.id ? "Edit sub-brand" : "Add sub-brand"}</h2></div>
            <form className="super-admin-form" onSubmit={saveSubBrand}>
              <label>Name<input required maxLength={120} value={subBrandForm.name} onChange={(event) => setSubBrandForm((form) => ({ ...form, name: event.target.value }))} /></label>
              <label>Contact person's name<input maxLength={120} value={subBrandForm.contactPerson} onChange={(event) => setSubBrandForm((form) => ({ ...form, contactPerson: event.target.value }))} /></label>
              <label>Contact phone<input type="tel" maxLength={40} value={subBrandForm.contactPhone} onChange={(event) => setSubBrandForm((form) => ({ ...form, contactPhone: event.target.value }))} /></label>
              <label>Contact email<input type="email" maxLength={254} value={subBrandForm.contactEmail} onChange={(event) => setSubBrandForm((form) => ({ ...form, contactEmail: event.target.value }))} /></label>
              <label>Full address<textarea rows="3" maxLength={1000} value={subBrandForm.address} onChange={(event) => setSubBrandForm((form) => ({ ...form, address: event.target.value }))} /></label>
              <label>Location URL<input type="url" maxLength={2048} value={subBrandForm.locationUrl} onChange={(event) => setSubBrandForm((form) => ({ ...form, locationUrl: event.target.value }))} /></label>
              <label>Sub-brand logo<input ref={subBrandLogoInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setSubBrandForm((form) => ({ ...form, logoFile: event.target.files?.[0] || null }))} /><small>JPEG, PNG, or WebP up to 2 MiB. Stored in the private sub-brand-logos bucket.</small></label>
              {(subBrandLogoPreview || subBrands.find((item) => item.id === subBrandForm.id)?.logoUrl) && (
                <img
                  className="sub-brand-logo-preview"
                  src={subBrandLogoPreview || subBrands.find((item) => item.id === subBrandForm.id)?.logoUrl}
                  alt="Sub-brand logo preview"
                />
              )}
              {schemaNotice && <p className="auth-feedback auth-error" role="alert">{schemaNotice}</p>}
              <div className="super-admin-form-actions">
                <button className="button button-primary" type="submit" disabled={actionBusy}>{actionBusy ? "Saving…" : subBrandForm.id ? "Save changes" : "Add sub-brand"}</button>
                {subBrandForm.id && <button className="button button-quiet" type="button" onClick={() => { setSubBrandForm(emptySubBrandForm); if (subBrandLogoInputRef.current) subBrandLogoInputRef.current.value = ""; }}>Cancel</button>}
              </div>
            </form>
          </section>
          <section className="dashboard-card super-admin-wide">
            <div className="dashboard-card-heading"><Boxes size={19} /><h2>Sub-brands</h2></div>
            <div className="super-admin-record-list">
              {subBrands.map((item) => {
                const legacyAdmin = profiles.find((candidate) => candidate.id === item.admin_user_id);
                return (
                  <article className="super-admin-record" key={item.id}>
                    <div className="sub-brand-record">
                      {item.logoUrl ? <img className="sub-brand-logo" src={item.logoUrl} alt={`${item.name} logo`} loading="lazy" /> : <div className="sub-brand-logo-placeholder"><ImageIcon size={20} /></div>}
                      <div>
                        <strong>{item.name}</strong>
                        <p>{item.contact_person || "No contact person"} · {item.contact_phone || "No phone"} · {item.contact_email || "No email"}</p>
                        <p>{item.address || "No address"} {item.location_url && <a href={item.location_url} target="_blank" rel="noreferrer">Map</a>}</p>
                        {legacyAdmin && <small>Existing legacy admin relation: {legacyAdmin.full_name || legacyAdmin.email || "Account"} (unchanged)</small>}
                        <span className={item.is_active ? "status-pill active" : "status-pill inactive"}>{item.is_active ? "Active" : "Inactive"}</span>
                      </div>
                    </div>
                    <div className="super-admin-record-actions">
                      <button className="text-button" type="button" onClick={() => editSubBrand(item)}>Edit</button>
                      <button className="text-button" type="button" onClick={() => setSubBrandActive(item, !item.is_active)}>{item.is_active ? "Deactivate" : "Activate"}</button>
                    </div>
                  </article>
                );
              })}
              {subBrands.length === 0 && <p>No sub-brands found.</p>}
            </div>
          </section>
        </div>
      )}

      {loadStatus === "loaded" && activeTab === "designs" && (
        <section className="dashboard-card super-admin-wide">
          <div className="dashboard-card-heading"><ImageIcon size={19} /><h2>All designs</h2></div>
          <p>Manage design details, publication, and deletion using the existing design operations.</p>
          <div className="super-admin-form-actions">
            <a className="button button-primary" href="/super-admin/add-design">Add Design</a>
            <a className="button button-quiet" href="/super-admin/designs">Open design manager</a>
          </div>
          <div className="admin-design-list">
            {designs.map((design) => (
              <article className="admin-design-item" key={design.id}>
                {design.imageUrl ? <img src={design.imageUrl} alt={design.name} loading="lazy" /> : <div className="design-image-placeholder"><ImageIcon size={25} /></div>}
                <div className="admin-design-content">
                  <div className="admin-design-title-row">
                    <div><h3>{design.name}</h3><p>{design.serial_number || "No serial number"}</p></div>
                    <span className={design.is_published ? "design-status published" : "design-status draft"}>{design.is_published ? "Published" : "Draft"}</span>
                  </div>
                  <p>{categories.find((item) => item.id === design.category_id)?.name || "Category unavailable"} · {subBrands.find((item) => item.id === design.sub_brand_id)?.name || "No sub-brand"}</p>
                  <p>Added by {profileNames.get(design.uploaded_by) || "Account"} · {formatDate(design.created_at)}</p>
                  {design.description && <p className="admin-design-description">{design.description}</p>}
                </div>
              </article>
            ))}
            {designs.length === 0 && <p>No designs found.</p>}
          </div>
        </section>
      )}

      {loadStatus === "loaded" && activeTab === "activity" && (
        <div className="super-admin-grid">
          <section className="dashboard-card">
            <div className="dashboard-card-heading"><Activity size={19} /><h2>Website activity</h2></div>
            <p>Showing the 200 most recent activity records.</p>
            {activityLogs.length ? (
              <ol className="super-admin-activity-list">
                {activityLogs.map((item) => (
                  <li key={item.id}>
                    <strong>{item.action}</strong>
                    <span>{profileNames.get(item.actor_id) || "System"} · {item.target_type || "Activity"} · {formatDate(item.created_at)}</span>
                    {item.details && <small>{JSON.stringify(item.details)}</small>}
                  </li>
                ))}
              </ol>
            ) : <p>No website activity has been recorded yet.</p>}
          </section>
          <section className="dashboard-card">
            <div className="dashboard-card-heading"><ImageIcon size={19} /><h2>Design views</h2></div>
            <p>Showing the 200 most recent design views.</p>
            {designViews.length ? (
              <ol className="super-admin-activity-list">
                {designViews.map((item) => (
                  <li key={item.id}>
                    <strong>{designNames.get(item.design_id) || "Design"}</strong>
                    <span>{profileNames.get(item.viewer_id) || (item.viewer_id ? "Account" : "Visitor")} · {formatDate(item.viewed_at)}</span>
                  </li>
                ))}
              </ol>
            ) : <p>No design views have been recorded yet.</p>}
          </section>
        </div>
      )}

      {loadStatus === "loaded" && activeTab === "analytics" && (
        <div className="super-admin-stat-grid">
          <StatCard label="Total designs" value={designs.length} icon={ImageIcon} />
          <StatCard label="Published" value={publishedDesigns} icon={ImageIcon} />
          <StatCard label="Active categories" value={categories.filter((item) => item.is_active).length} icon={Layers3} />
          <StatCard label="Active sub-brands" value={subBrands.filter((item) => item.is_active).length} icon={Boxes} />
          <StatCard label="Views in recent window" value={designViews.length} icon={Activity} />
        </div>
      )}

      {loadStatus === "loaded" && activeTab === "settings" && (
        <section className="dashboard-card super-admin-wide">
          <div className="dashboard-card-heading"><Settings size={19} /><h2>Account and security</h2></div>
          <dl className="profile-details">
            <div><dt>Signed in as</dt><dd>{profile?.full_name?.trim() || "Super Admin"}</dd></div>
            <div><dt>Account email</dt><dd>{profile?.email || "Not available"}</dd></div>
            <div><dt>Role</dt><dd>super_admin (verified from profiles)</dd></div>
          </dl>
          <p>Management writes remain subject to the existing Supabase Row Level Security policies.</p>
          <button className="button dashboard-logout" type="button" onClick={onLogout}>Log out</button>
        </section>
      )}
    </div>
  );
}

function StatCard({ label, value, icon: Icon }) {
  return (
    <article className="dashboard-card super-admin-stat">
      <div className="super-admin-stat-icon"><Icon size={19} /></div>
      <p>{label}</p>
      <strong>{value}</strong>
    </article>
  );
}
