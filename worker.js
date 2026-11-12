const REPOSITORY = "jannyfuentes60-netizen/metodolachamba";
const RELEASES_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const ALLOWED_ORIGIN = "https://lachambadjs.github.io";

function json(data, status = 200, origin = ALLOWED_ORIGIN) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    },
  });
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
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
    throw new Error(`GitHub release lookup failed: ${response.status}`);
  }
  return response.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || ALLOWED_ORIGIN;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname !== "/api/app-update" && url.pathname !== "/") {
      return json({ error: "Ruta no encontrada." }, 404, origin);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "Método no permitido." }, 405, origin);
    }

    const token = env.GITHUB_RELEASE_TOKEN;
    if (!token) {
      return json({ error: "El servicio de actualizaciones aún no está configurado." }, 503, origin);
    }

    try {
      const release = await latestRelease(token);
      const tag = String(release.tag_name || "").replace(/^[vV]/, "");
      const buildText = tag.split("+").pop() || "";
      const buildNumber = Number.parseInt(buildText, 10) || 0;
      const version = tag.split("+")[0] || tag;
      const apk = (release.assets || []).find(asset =>
        String(asset.name || "").toLowerCase().endsWith(".apk")
      );

      if (!apk || !apk.url || buildNumber < 1) {
        return json({ error: "No hay una versión instalable publicada." }, 404, origin);
      }

      if (url.searchParams.get("download") === "1") {
        const download = await fetch(apk.url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/octet-stream",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "La-Chamba-Audio-Lab",
          },
          redirect: "follow",
          cache: "no-store",
        });

        if (!download.ok || !download.body) {
          return json({ error: "No se pudo obtener el instalador." }, 502, origin);
        }

        const headers = new Headers({
          "Content-Type": "application/vnd.android.package-archive",
          "Content-Disposition": 'attachment; filename="La-Chamba-Audio-Lab.apk"',
          "Cache-Control": "no-store",
          ...corsHeaders(origin),
        });
        const length = download.headers.get("content-length");
        if (length) headers.set("Content-Length", length);

        return new Response(request.method === "HEAD" ? null : download.body, {
          status: 200,
          headers,
        });
      }

      return json({
        version,
        buildNumber,
        releaseNotes: String(release.body || ""),
        downloadUrl: `${url.origin}/api/app-update?download=1`,
      }, 200, origin);
    } catch (error) {
      console.error("app-update endpoint:", error);
      return json({ error: "No se pudo consultar la versión más reciente." }, 502, origin);
    }
  },
};
