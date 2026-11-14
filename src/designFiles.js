export const MAX_DESIGN_FILE_SIZE = 25 * 1024 * 1024;
export const MAX_DESIGN_FILE_COUNT = 10;

const fileTypes = {
  jpg: { mime: "image/jpeg", aliases: ["image/pjpeg"], signature: "jpeg", preview: true },
  jpeg: { mime: "image/jpeg", aliases: ["image/pjpeg"], signature: "jpeg", preview: true },
  png: { mime: "image/png", signature: "png", preview: true },
  webp: { mime: "image/webp", signature: "webp", preview: true },
  bmp: { mime: "image/bmp", aliases: ["image/x-ms-bmp"], signature: "bmp", preview: true },
  gif: { mime: "image/gif", signature: "gif", preview: true },
  tiff: { mime: "image/tiff", aliases: ["image/x-tiff"], signature: "tiff", preview: true },
  tif: { mime: "image/tiff", aliases: ["image/x-tiff"], signature: "tiff", preview: true },
  svg: { mime: "image/svg+xml", signature: "svg", preview: true },
  eps: { mime: "application/postscript", aliases: ["image/eps", "application/eps"], signature: "postscript" },
  ai: { mime: "application/postscript", aliases: ["application/pdf"], signature: "illustrator", preview: true },
  cdr: { mime: "application/vnd.corel-draw", aliases: ["application/cdr", "application/x-cdr", "image/x-coreldraw"], signature: "cdr" },
  pdf: { mime: "application/pdf", signature: "pdf", preview: true },
  psd: { mime: "image/vnd.adobe.photoshop", aliases: ["image/x-photoshop", "image/photoshop"], signature: "psd", preview: true },
  psb: { mime: "image/vnd.adobe.photoshop", aliases: ["image/x-photoshop", "image/photoshop"], signature: "psb", preview: true },
  dxf: { mime: "image/vnd.dxf", aliases: ["application/dxf", "application/x-dxf", "image/x-dxf"], signature: "dxf", preview: true },
  dwg: { mime: "image/vnd.dwg", aliases: ["application/acad", "application/x-dwg", "image/x-dwg"], signature: "dwg" },
  zip: { mime: "application/zip", aliases: ["application/x-zip-compressed"], signature: "zip" },
  rar: { mime: "application/vnd.rar", aliases: ["application/x-rar-compressed"], signature: "rar" },
};

export const ACCEPTED_DESIGN_EXTENSIONS = Object.keys(fileTypes).map((extension) => `.${extension}`).join(",");
export const ACCEPTED_PREVIEW_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "bmp", "gif", "tiff", "tif", "svg"]
  .map((extension) => `.${extension}`)
  .join(",");
export const DESIGN_BUCKET_MIME_TYPES = [...new Set(Object.values(fileTypes).flatMap(({ mime, aliases = [] }) => [mime, ...aliases]))];

export function getDesignFileExtension(fileName = "") {
  return fileName.split(".").pop()?.toLowerCase() || "";
}

export function isPreviewableDesignFile(file) {
  const extension = typeof file === "string" ? getDesignFileExtension(file) : getDesignFileExtension(file?.name);
  return Boolean(fileTypes[extension]?.preview);
}

function startsWithBytes(bytes, values, offset = 0) {
  return values.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes, start = 0, end = bytes.length) {
  return new TextDecoder("latin1").decode(bytes.slice(start, end));
}

function hasSafeSvgMarkup(text) {
  return /<svg\b/i.test(text)
    && !/<!DOCTYPE|<!ENTITY|<(?:script|foreignObject|iframe|object|embed)\b|\bon[a-z]+\s*=|javascript\s*:|@import|url\(\s*['"]?(?!#)/i.test(text)
    && !/(?:href|src)\s*=\s*(["'])(?!#)[^"']*\1/i.test(text);
}

async function matchesSignature(file, signature) {
  if (signature === "svg") return hasSafeSvgMarkup(await file.text());

  const bytes = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
  const text = ascii(bytes);
  switch (signature) {
    case "jpeg": return startsWithBytes(bytes, [0xff, 0xd8, 0xff]);
    case "png": return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "webp": return text.startsWith("RIFF") && text.slice(8, 12) === "WEBP";
    case "bmp": return text.startsWith("BM");
    case "gif": return text.startsWith("GIF87a") || text.startsWith("GIF89a");
    case "tiff": return startsWithBytes(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWithBytes(bytes, [0x4d, 0x4d, 0x00, 0x2a]);
    case "pdf": return text.startsWith("%PDF-");
    case "postscript": return text.startsWith("%!PS");
    case "illustrator": return text.startsWith("%!PS") || text.startsWith("%PDF-");
    case "cdr": return text.startsWith("RIFF") && text.slice(8, 11) === "CDR";
    case "psd": return startsWithBytes(bytes, [0x38, 0x42, 0x50, 0x53, 0x00, 0x01]);
    case "psb": return startsWithBytes(bytes, [0x38, 0x42, 0x50, 0x53, 0x00, 0x02]);
    case "dxf": return text.startsWith("AutoCAD Binary DXF\r\n\x1a\0")
      || /^(?:\s*0\s*[\r\n]+\s*SECTION\b|\s*999\s*[\r\n]+[^\r\n]*[\r\n]+\s*0\s*[\r\n]+\s*SECTION\b)/i.test(text);
    case "dwg": return /^AC(?:1009|1012|1014|1015|1018|1019|1021|1024|1027|1032|1036)/.test(text);
    case "zip": return startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04])
      || startsWithBytes(bytes, [0x50, 0x4b, 0x05, 0x06])
      || startsWithBytes(bytes, [0x50, 0x4b, 0x07, 0x08]);
    case "rar": return startsWithBytes(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])
      || startsWithBytes(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
    default: return false;
  }
}

export async function validateDesignFile(file) {
  const extension = getDesignFileExtension(file?.name);
  const definition = fileTypes[extension];
  if (!definition) throw new Error(`${file?.name || "This file"} has an unsupported file extension.`);
  if (!file.size) throw new Error(`${file.name} is empty.`);
  if (file.size > MAX_DESIGN_FILE_SIZE) throw new Error(`${file.name} exceeds the 25 MiB per-file limit.`);

  const providedType = file.type?.toLowerCase();
  const knownTypes = [definition.mime, ...definition.aliases || []];
  if (providedType && providedType !== "application/octet-stream" && !knownTypes.includes(providedType)) {
    throw new Error(`${file.name} has a MIME type that does not match its .${extension} extension.`);
  }
  if (!await matchesSignature(file, definition.signature)) {
    throw new Error(`${file.name} does not contain a valid ${extension.toUpperCase()} file signature.`);
  }

  return {
    extension,
    contentType: providedType && providedType !== "application/octet-stream" ? providedType : definition.mime,
    preview: definition.preview === true,
  };
}

export function getLegacyDesignAsset(path) {
  const name = path?.split("/").pop() || "design-file";
  const extension = getDesignFileExtension(name);
  const definition = fileTypes[extension];
  return {
    name,
    path,
    type: definition?.mime || "application/octet-stream",
    size: null,
  };
}

export async function createWatermarkedDesignPreview(file) {
  const extension = getDesignFileExtension(file?.name);
  let sourceFile = file;
  if (extension === "pdf") sourceFile = await renderPdfPreview(file);
  else if (extension === "ai") {
    const header = new TextDecoder("latin1").decode(new Uint8Array(await file.slice(0, 8).arrayBuffer()));
    if (!header.startsWith("%PDF-")) throw new Error("This AI file is not PDF-compatible. Upload a separate preview image.");
    sourceFile = await renderPdfPreview(file);
  } else if (["psd", "psb"].includes(extension)) sourceFile = await renderPhotoshopPreview(file);
  else if (["tif", "tiff"].includes(extension)) sourceFile = await renderTiffPreview(file);
  else if (extension === "dxf") sourceFile = await renderDxfPreview(file);
  else if (!isPreviewableDesignFile(file)) {
    throw new Error(`Automatic preview conversion is unavailable for .${extension}. Upload a separate preview image.`);
  }

  let bitmap;
  let drawable;
  let width;
  let height;
  try {
    try {
      bitmap = await createImageBitmap(sourceFile);
      drawable = bitmap;
      width = bitmap.width;
      height = bitmap.height;
    } catch {
      const objectUrl = URL.createObjectURL(sourceFile);
      try {
        drawable = await new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error("The preview image could not be decoded."));
          image.src = objectUrl;
        });
        width = drawable.naturalWidth;
        height = drawable.naturalHeight;
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    }
    if (!width || !height) return null;
    const maxDimension = 960;
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(drawable, 0, 0, canvas.width, canvas.height);

    context.save();
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(-Math.PI / 6);
    context.font = `600 ${Math.max(18, Math.round(Math.min(canvas.width, canvas.height) / 11))}px sans-serif`;
    context.fillStyle = "rgba(255,255,255,0.46)";
    context.strokeStyle = "rgba(20,35,27,0.24)";
    context.lineWidth = 2;
    context.textAlign = "center";
    const step = Math.max(130, Math.round(canvas.width / 2));
    for (let y = -canvas.height; y <= canvas.height; y += step) {
      for (let x = -canvas.width; x <= canvas.width; x += step * 1.8) {
        context.strokeText("SRI HARI DESIGNER", x, y);
        context.fillText("SRI HARI DESIGNER", x, y);
      }
    }
    context.restore();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.78));
    if (!blob) return null;
    const extension = blob.type === "image/webp" ? "webp" : "png";
    return new File([blob], `design-preview.${extension}`, { type: blob.type });
  } catch (error) {
    throw new Error(`Preview generation failed for ${file.name}: ${error instanceof Error ? error.message : "unsupported or corrupt design data"}`);
  } finally {
    bitmap?.close();
  }
}

async function canvasToImageFile(canvas, name = "design-preview.png") {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob ? new File([blob], name, { type: "image/png" }) : null;
}

async function renderPdfPreview(file) {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const pdfDocument = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  try {
    const page = await pdfDocument.getPage(1);
    const sourceViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(1.5, 960 / Math.max(sourceViewport.width, sourceViewport.height));
    const viewport = page.getViewport({ scale });
    const canvas = Object.assign(globalThis.document.createElement("canvas"), {
      width: Math.ceil(viewport.width),
      height: Math.ceil(viewport.height),
    });
    const context = canvas.getContext("2d");
    if (!context) throw new Error("A PDF preview canvas could not be created.");
    await page.render({ canvasContext: context, canvas, viewport }).promise;
    const preview = await canvasToImageFile(canvas);
    if (!preview) throw new Error("The first PDF page could not be converted to an image.");
    return preview;
  } finally {
    await pdfDocument.destroy();
  }
}

async function renderPhotoshopPreview(file) {
  const { readPsd } = await import("ag-psd");
  const psd = readPsd(await file.arrayBuffer(), { useImageData: true, skipLayerImageData: true, skipThumbnail: true });
  const imageData = psd.imageData;
  if (!imageData?.width || !imageData?.height || !imageData.data) {
    throw new Error("This Photoshop file has no readable composite image. Upload a separate preview image.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("A Photoshop preview canvas could not be created.");
  let pixels = imageData.data;
  if (pixels instanceof Uint16Array) {
    pixels = Uint8ClampedArray.from(pixels, (value) => Math.round(value / 257));
  } else if (pixels instanceof Float32Array) {
    pixels = Uint8ClampedArray.from(pixels, (value) => Math.round(Math.max(0, Math.min(1, value)) * 255));
  }
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels), imageData.width, imageData.height), 0, 0);
  const preview = await canvasToImageFile(canvas);
  if (!preview) throw new Error("The Photoshop composite could not be converted to an image.");
  return preview;
}

async function renderTiffPreview(file) {
  const { default: UTIF } = await import("utif");
  const buffer = await file.arrayBuffer();
  const directories = UTIF.decode(buffer);
  if (!directories.length) throw new Error("No TIFF image page was found.");
  UTIF.decodeImage(buffer, directories[0]);
  const directory = directories[0];
  if (!directory.width || !directory.height) throw new Error("The first TIFF page has invalid dimensions.");
  const canvas = document.createElement("canvas");
  canvas.width = directory.width;
  canvas.height = directory.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("A TIFF preview canvas could not be created.");
  context.putImageData(new ImageData(new Uint8ClampedArray(UTIF.toRGBA8(directory)), directory.width, directory.height), 0, 0);
  const preview = await canvasToImageFile(canvas);
  if (!preview) throw new Error("The first TIFF page could not be converted to an image.");
  return preview;
}

async function renderDxfPreview(file) {
  const { DxfParser } = await import("dxf-parser");
  const drawing = new DxfParser().parseSync(await file.text());
  const entities = (drawing.entities || []).filter((entity) => ["LINE", "LWPOLYLINE", "POLYLINE", "CIRCLE"].includes(entity.type));
  const points = [];
  const addPoint = (point) => { if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) points.push(point); };
  entities.forEach((entity) => {
    if (entity.type === "LINE") { addPoint(entity.startPoint); addPoint(entity.endPoint); }
    if (["LWPOLYLINE", "POLYLINE"].includes(entity.type)) (entity.vertices || []).forEach(addPoint);
    if (entity.type === "CIRCLE" && entity.center && Number.isFinite(entity.radius)) {
      addPoint({ x: entity.center.x - entity.radius, y: entity.center.y - entity.radius });
      addPoint({ x: entity.center.x + entity.radius, y: entity.center.y + entity.radius });
    }
  });
  if (!points.length) throw new Error("This DXF has no supported 2D entities. Upload a separate preview image.");

  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const sourceWidth = Math.max(maxX - minX, 1);
  const sourceHeight = Math.max(maxY - minY, 1);
  const scale = Math.min(900 / sourceWidth, 900 / sourceHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(sourceWidth * scale + 48));
  canvas.height = Math.max(1, Math.ceil(sourceHeight * scale + 48));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("A CAD preview canvas could not be created.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#1c3529";
  context.lineWidth = Math.max(1, scale * 0.6);
  const project = (point) => ({ x: 24 + (point.x - minX) * scale, y: canvas.height - 24 - (point.y - minY) * scale });
  entities.forEach((entity) => {
    if (entity.type === "LINE") {
      const start = project(entity.startPoint);
      const end = project(entity.endPoint);
      context.beginPath(); context.moveTo(start.x, start.y); context.lineTo(end.x, end.y); context.stroke();
    } else if (["LWPOLYLINE", "POLYLINE"].includes(entity.type)) {
      const vertices = (entity.vertices || []).map(project);
      if (vertices.length < 2) return;
      context.beginPath(); context.moveTo(vertices[0].x, vertices[0].y);
      vertices.slice(1).forEach((point) => context.lineTo(point.x, point.y));
      if (entity.shape || entity.closed) context.closePath();
      context.stroke();
    } else if (entity.type === "CIRCLE" && entity.center && Number.isFinite(entity.radius)) {
      const center = project(entity.center);
      context.beginPath(); context.arc(center.x, center.y, entity.radius * scale, 0, Math.PI * 2); context.stroke();
    }
  });
  const preview = await canvasToImageFile(canvas);
  if (!preview) throw new Error("The DXF geometry could not be converted to an image.");
  return preview;
}