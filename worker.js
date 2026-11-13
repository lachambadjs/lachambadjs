const REPOSITORY = "jannyfuentes60-netizen/metodolachamba";
const RELEASES_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const ALLOWED_ORIGINS = new Set([
  "https://lachambadjs.github.io",
]);

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(data, status = 200, origin = null, method = "GET") {
  return new Response(method === "HEAD" ? null : JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      ...corsHeaders(origin),
    },
  });
}

function getGithubToken(env) {
  // Accept the three binding names that may already exist in Cloudflare.
  return env.GITHUB_RELEASE_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || null;
}

async function latestRelease(token) {
  const response = await fetch(RELEASES_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "La-Chamba-Audio-Lab",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("GitHub release lookup failed:", response.status, detail.slice(0, 500));
    throw new Error(`GitHub release lookup failed: ${response.status}`);
  }

  return response.json();
}

function getReleaseInfo(release, origin) {
  const tag = String(release.tag_name || "").replace(/^[vV]/, "");
  const [versionPart, buildPart = ""] = tag.split("+", 2);
  const buildNumber = Number.parseInt(buildPart, 10) || 0;
  const version = versionPart || tag;
  const apk = (release.assets || []).find(asset =>
    String(asset.name || "").toLowerCase().endsWith(".apk")
  );

  if (!apk || !apk.url || !version || buildNumber < 1) {
    return null;
  }

  return {
    version,
    buildNumber,
    releaseNotes: String(release.body || ""),
    assetApiUrl: apk.url,
    assetSize: Number(apk.size) || null,
    downloadUrl: `${origin}/api/app-update?download=1`,
  };
}

async function downloadApk(assetUrl, token) {
  return fetch(assetUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/octet-stream",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "La-Chamba-Audio-Lab",
    },
    redirect: "follow",
    cache: "no-store",
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const requestOrigin = request.headers.get("Origin");
    const origin = requestOrigin && ALLOWED_ORIGINS.has(requestOrigin)
      ? requestOrigin
      : null;
    const method = request.method;

    if (method === "OPTIONS") {
      if (requestOrigin && !origin) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin || "https://lachambadjs.github.io"),
      });
    }

    if (url.pathname === "/api/diagnostic" || url.pathname === "/api/health") {
      return json({
        ok: true,
        worker: "la-chamba-download-api",
        repository: REPOSITORY,
        tokenConfigured: Boolean(getGithubToken(env)),
      }, 200, origin, method);
    }

    if (url.pathname !== "/api/app-update" && url.pathname !== "/") {
      return json({ error: "Ruta no encontrada." }, 404, origin, method);
    }

    if (method !== "GET" && method !== "HEAD") {
      return json({ error: "Método no permitido." }, 405, origin, method);
    }

    const token = getGithubToken(env);
    if (!token) {
      return json({
        error: "Falta configurar el secreto de GitHub en Cloudflare.",
        requiredSecret: "GITHUB_RELEASE_TOKEN",
        acceptedBindings: ["GITHUB_RELEASE_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"],
      }, 503, origin, method);
    }

    try {
      const release = await latestRelease(token);
      const info = getReleaseInfo(release, url.origin);

      if (!info) {
        return json({
          error: "La última Release no contiene un APK o su etiqueta no incluye versión+build.",
          tag: String(release.tag_name || ""),
        }, 404, origin, method);
      }

      if (url.searchParams.get("download") !== "1") {
        const { assetApiUrl, assetSize, ...publicInfo } = info;
        return json(publicInfo, 200, origin, method);
      }

      // HEAD should report metadata without transferring a 60+ MB APK.
      if (method === "HEAD") {
        const headers = new Headers({
          "Content-Type": "application/vnd.android.package-archive",
          "Content-Disposition": 'attachment; filename="La-Chamba-Audio-Lab.apk"',
          "Cache-Control": "no-store",
          ...corsHeaders(origin),
        });
        if (info.assetSize) headers.set("Content-Length", String(info.assetSize));
        return new Response(null, { status: 200, headers });
      }

      const download = await downloadApk(info.assetApiUrl, token);
      if (!download.ok || !download.body) {
        const detail = await download.text().catch(() => "");
        console.error("GitHub APK download failed:", download.status, detail.slice(0, 500));
        return json({
          error: "GitHub no permitió descargar el APK.",
          githubStatus: download.status,
        }, 502, origin, method);
      }

      const headers = new Headers({
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Disposition": 'attachment; filename="La-Chamba-Audio-Lab.apk"',
        "Cache-Control": "no-store",
        ...corsHeaders(origin),
      });
      const length = download.headers.get("content-length") || (info.assetSize ? String(info.assetSize) : null);
      if (length) headers.set("Content-Length", length);

      return new Response(download.body, { status: 200, headers });
    } catch (error) {
      console.error("app-update endpoint:", error);
      const match = String(error?.message || "").match(/failed: (\d{3})/);
      return json({
        error: "No se pudo consultar la última versión de GitHub.",
        githubStatus: match ? Number(match[1]) : null,
        reason: match
          ? "github_api_rejected_request"
          : "network_or_response_error",
      }, 502, origin, method);
    }
  },
};
