export default async function handler(req, res) {
  const host = req.headers.host || "anylist-recipe-importer.vercel.app";
  const proto = req.headers["x-forwarded-proto"] || "https";
  const url = new URL(req.url, `${proto}://${host}`);
  const target = (url.searchParams.get("u") || "").trim();

  if (!target || !/^https?:\/\//i.test(target)) {
    res.status(400).send("Missing or invalid image url");
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const resp = await fetch(target, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        Accept: "image/jpeg,image/png,image/webp,image/*,*/*;q=0.8",
      },
    });
    if (!resp.ok) {
      res.status(404).end();
      return;
    }

    const contentType = resp.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) {
      res.status(404).end();
      return;
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.status(200).send(buf);
  } catch {
    res.status(404).end();
  } finally {
    clearTimeout(timer);
  }
}
