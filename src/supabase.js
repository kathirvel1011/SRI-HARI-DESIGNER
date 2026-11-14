import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(
  supabaseUrl,
  supabaseKey
);

export async function fetchAllRows(buildQuery, pageSize = 500) {
  const rows = [];
  let from = 0;

  while (true) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const page = data || [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
    from += pageSize;
  }
}

export async function uploadFileWithProgress(bucket, path, file, contentType, onProgress) {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (!session?.access_token) throw new Error("Your upload session expired. Sign in again and retry.");

  const objectPath = path.split("/").map(encodeURIComponent).join("/");
  const requestUrl = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${objectPath}`;
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", requestUrl);
    request.setRequestHeader("apikey", supabaseKey);
    request.setRequestHeader("Authorization", `Bearer ${session.access_token}`);
    request.setRequestHeader("Content-Type", contentType);
    request.setRequestHeader("cache-control", "max-age=3600");
    request.setRequestHeader("x-upsert", "false");
    request.timeout = 120000;
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve();
        return;
      }
      let message = request.statusText || "Storage rejected the upload.";
      try {
        const response = JSON.parse(request.responseText);
        message = response.message || response.error || message;
      } catch {
        if (request.responseText) message = request.responseText;
      }
      reject(new Error(message));
    });
    request.addEventListener("error", () => reject(new Error("The file could not be uploaded. Check your connection and retry.")));
    request.addEventListener("timeout", () => reject(new Error("The file upload timed out. Check your connection and retry.")));
    request.addEventListener("abort", () => reject(new Error("The file upload was cancelled.")));
    request.send(file);
  });
}