import zlib from "node:zlib";

function decodePayload(encoded) {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const buf = Buffer.from(b64 + pad, "base64");
  try {
    return JSON.parse(zlib.inflateRawSync(buf).toString("utf-8"));
  } catch {
    return JSON.parse(buf.toString("utf-8"));
  }
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanMarkdownInline(text = "") {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|\s)_([^_\n]+?)_(\s|$|[，。；！？、.,;!?])/g, "$1$2$3")
    .trim();
}

function markdownToHtmlInline(text = "") {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/(^|\s)_([^_\n]+?)_(\s|$|[，。；！？、.,;!?])/g, "$1<em>$2</em>$3");
}

function normalizeImageUrl(raw = "") {
  const cleaned = String(raw)
    .replace(/&amp;/g, "&")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u002F/gi, "/")
    .replace(/\\u003D/gi, "=")
    .replace(/\\\//g, "/")
    .trim();
  if (!cleaned) return "";
  if (cleaned.startsWith("//")) return "https:" + cleaned;
  if (cleaned.startsWith("http://") && /xhscdn\.com|douyinpic\.com|byteimg\.com/i.test(cleaned)) {
    return cleaned.replace(/^http:\/\//i, "https://");
  }
  return /^https?:\/\//i.test(cleaned) ? cleaned : "";
}

async function fetchCoverImageFromSource(pageUrl) {
  if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) return "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const resp = await fetch(pageUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    });
    if (!resp.ok) return "";
    const html = await resp.text();

    const patterns = [
      /<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/i,
      /<meta[^>]+(?:property|name)=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /"origin_cover"\s*:\s*\{[^}]*"url_list"\s*:\s*\[\s*"([^"]+)"/i,
      /"cover"\s*:\s*\{[^}]*"url_list"\s*:\s*\[\s*"([^"]+)"/i,
      /"urlDefault"\s*:\s*"(https?:\\?\/\\?\/sns-webpic[^"]+)"/i,
      /(https?:\\?\/\\?\/p\d+[^"'\s\\<>]*douyinpic\.com[^"'\s<>]+)/i,
      /(https?:\/\/sns-webpic[^"'\s\\<>]+)/i,
    ];

    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1]) {
        const candidate = normalizeImageUrl(m[1]);
        if (candidate) return candidate;
      }
    }
    return "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function getIngredientSections(text = "") {
  const lines = text.split("\n");
  const sections = [];
  let currentSection = { name: "", items: [] };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (
      /^(Prep|Cook|Total|Yield|Source|URL|Image)[^a-zA-Z]*[:：]/i.test(trimmed) ||
      /^(Calories?|热量)[^a-zA-Z]*[:：]/i.test(trimmed) ||
      /^(Protein|蛋白质)[^a-zA-Z]*[:：]/i.test(trimmed) ||
      /^(Carbs?|Carbohydrates?|碳水化合物|碳水)[^a-zA-Z]*[:：]/i.test(trimmed) ||
      /^(Fat|脂肪)[^a-zA-Z]*[:：]/i.test(trimmed) ||
      /^(Fiber|膳食纤维|纤维)[^a-zA-Z]*[:：]/i.test(trimmed) ||
      /^(Sodium|钠)[^a-zA-Z]*[:：]/i.test(trimmed)
    ) {
      continue;
    }

    if (trimmed.startsWith("#")) {
      if (currentSection.items.length > 0 || currentSection.name) {
        sections.push(currentSection);
      }
      const sectionName = trimmed.replace(/^#+\s*/, "").trim();
      if (/营养|[Nn]utrition/i.test(sectionName)) {
        currentSection = { name: "", items: [] };
        continue;
      }
      currentSection = { name: sectionName, items: [] };
    } else {
      currentSection.items.push(trimmed);
    }
  }

  if (currentSection.items.length > 0) {
    sections.push(currentSection);
  }

  return sections.filter((s) => s.items.length > 0);
}

function getMergedSteps(text = "") {
  const rawLines = text.split("\n");
  const steps = [];
  let multilineBuffer = [];

  const flushBuffer = () => {
    if (multilineBuffer.length > 0) {
      steps.push({
        isHeading: false,
        lines: multilineBuffer,
        rawText: multilineBuffer.map(cleanMarkdownInline).join("\n"),
      });
      multilineBuffer = [];
    }
  };

  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      flushBuffer();
      continue;
    }

    if (trimmed.startsWith("#")) {
      flushBuffer();
      const heading = trimmed.replace(/^#+\s*/, "").trim();
      if (heading) {
        steps.push({
          isHeading: true,
          lines: [heading],
          rawText: `# ${heading}`,
        });
      }
      continue;
    }

    if (trimmed.startsWith(">")) {
      const content = trimmed.replace(/^>\s*/, "").trim();
      if (content) {
        multilineBuffer.push(content);
      }
      continue;
    }

    flushBuffer();
    steps.push({
      isHeading: false,
      lines: [trimmed],
      rawText: cleanMarkdownInline(trimmed),
    });
  }

  flushBuffer();
  return steps;
}

export default async function handler(req, res) {
  try {
    const host = req.headers.host || "anylist-recipe-importer.vercel.app";
    const proto = req.headers["x-forwarded-proto"] || "https";
    const url = new URL(req.url, `${proto}://${host}`);
    const d = url.searchParams.get("d");
    if (!d) {
      res.status(400).send("Missing recipe data (?d=...)");
      return;
    }

    const recipe = decodePayload(d);
    const title = recipe.title || "Untitled Recipe";
    const sourceName = (recipe.source_name || "").trim();
    const sourceUrl = (recipe.source_url || "").trim();

    let rawImageUrl = normalizeImageUrl(recipe.image_url || "");
    if (!rawImageUrl && sourceUrl) {
      rawImageUrl = await fetchCoverImageFromSource(sourceUrl);
    }

    const needsProxy = /xhscdn\.com|douyinpic\.com|byteimg\.com|douyin\.com/i.test(rawImageUrl);
    const finalImageUrl = rawImageUrl
      ? needsProxy
        ? `${proto}://${host}/api/img?u=${encodeURIComponent(rawImageUrl)}`
        : rawImageUrl
      : "";

    const sections = getIngredientSections(recipe.ingredients_text || "");
    const steps = getMergedSteps(recipe.steps_text || "");

    const recipeIngredientList = [];
    for (const section of sections) {
      if (section.name) {
        recipeIngredientList.push(`${section.name}:`);
      }
      for (const item of section.items) {
        recipeIngredientList.push(item);
      }
    }

    const sourceLine = (sourceName || sourceUrl)
      ? `原方来源：${[sourceName, sourceUrl].filter(Boolean).join(" ")}`
      : "";
    const fullNotes = [sourceLine, recipe.notes].filter(Boolean).join("\n");

    const toIsoDuration = (val) => {
      if (!val) return undefined;
      const digits = String(val).replace(/\D/g, "");
      return digits ? `PT${digits}M` : undefined;
    };

    const jsonLd = {
      "@context": "https://schema.org/",
      "@type": "Recipe",
      name: title,
      image: finalImageUrl ? [finalImageUrl] : undefined,
      description: fullNotes || undefined,
      author: sourceName ? { "@type": "Person", name: sourceName } : undefined,
      publisher: sourceName
        ? { "@type": "Organization", name: sourceName }
        : undefined,
      recipeIngredient: recipeIngredientList,
      recipeInstructions: steps.map((step) => ({
        "@type": "HowToStep",
        text: step.rawText,
      })),
      prepTime: toIsoDuration(recipe.prep_time),
      cookTime: toIsoDuration(recipe.cook_time),
      totalTime: toIsoDuration(recipe.total_time),
      recipeYield: recipe.yield_amount || undefined,
    };

    if (recipe.calories || recipe.protein || recipe.fat || recipe.carbs) {
      jsonLd.nutrition = {
        "@type": "NutritionInformation",
        calories: recipe.calories ? `${recipe.calories} calories` : undefined,
        proteinContent: recipe.protein ? `${recipe.protein} g` : undefined,
        fatContent: recipe.fat ? `${recipe.fat} g` : undefined,
        carbohydrateContent: recipe.carbs ? `${recipe.carbs} g` : undefined,
        fiberContent: recipe.fiber ? `${recipe.fiber} g` : undefined,
        sodiumContent: recipe.sodium ? `${recipe.sodium} mg` : undefined,
      };
    }

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Recipe</title>
  ${finalImageUrl ? `<meta property="og:image" content="${escapeHtml(finalImageUrl)}">` : ""}
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; line-height: 1.65; color: #222; max-width: 760px; margin: 0 auto; padding: 36px 20px; background: #fff; }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    .hero { width: 100%; max-height: 420px; object-fit: cover; border-radius: 12px; margin: 12px 0 18px; }
    .meta { display: flex; gap: 16px; color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; flex-wrap: wrap; border-bottom: 1px solid #eee; padding-bottom: 0.8rem; }
    h2 { border-bottom: 2px solid #f0f0f0; padding-bottom: 8px; margin-top: 28px; font-size: 1.25rem; }
    h3 { color: #0284c7; margin-top: 20px; font-size: 1.05rem; border-bottom: 1px solid #bae6fd; padding-bottom: 4px; display: inline-block; }
    ul, ol { padding-left: 20px; }
    li { margin-bottom: 10px; }
    .notes { background: #fffbeb; padding: 14px 18px; border-radius: 8px; border-left: 4px solid #f59e0b; margin-top: 24px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${finalImageUrl ? `<img class="hero" src="${escapeHtml(finalImageUrl)}" alt="${escapeHtml(title)}" referrerpolicy="no-referrer" />` : ""}
  <div class="meta">
    ${recipe.prep_time ? `<span><b>准备:</b> ${escapeHtml(recipe.prep_time)}</span>` : ""}
    ${recipe.cook_time ? `<span><b>烹饪:</b> ${escapeHtml(recipe.cook_time)}</span>` : ""}
    ${recipe.total_time ? `<span><b>总计:</b> ${escapeHtml(recipe.total_time)}</span>` : ""}
    ${recipe.yield_amount ? `<span><b>份量:</b> ${escapeHtml(recipe.yield_amount)}</span>` : ""}
    ${sourceName || sourceUrl ? `<span><b>来源:</b> ${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceName || sourceUrl)}</a>` : escapeHtml(sourceName)}</span>` : ""}
  </div>
  <section>
    <h2>Ingredients 食材</h2>
    ${sections
      .map(
        (s) => `${s.name ? `<h3>${escapeHtml(s.name)}</h3>` : ""}<ul>${s.items
          .map((item) => `<li itemprop="recipeIngredient">${escapeHtml(item)}</li>`)
          .join("")}</ul>`
      )
      .join("")}
  </section>
  <section>
    <h2>Instructions 步骤</h2>
    <ol>
      ${steps
        .map((s) =>
          s.isHeading
            ? `</ol><h3>${escapeHtml(s.lines[0])}</h3><ol>`
            : `<li>${s.lines.map(markdownToHtmlInline).join("<br>")}</li>`
        )
        .join("")}
    </ol>
  </section>
  ${
    recipe.notes
      ? `<section class="notes"><strong>Notes 备注</strong><br>${recipe.notes
          .split("\n")
          .map(escapeHtml)
          .join("<br>")}</section>`
      : ""
  }
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  } catch (err) {
    res.status(400).send("Invalid recipe link: " + (err?.message || "unknown error"));
  }
}
