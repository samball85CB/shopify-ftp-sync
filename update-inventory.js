const ftp = require("basic-ftp");
const { Writable } = require("stream");
const { parse } = require("csv-parse/sync");
const axios = require("axios");

// download remote FTP file into a Buffer
async function downloadToBuffer(client, path) {
  const chunks = [];
  const writer = new Writable({
    write(chunk, _, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  await client.downloadTo(writer, path);
  return Buffer.concat(chunks);
}

async function main() {
  const {
    FTP_HOST,
    FTP_PORT = "21",
    FTP_USER,
    FTP_PASSWORD,
    SHOPIFY_STORE,
    SHOPIFY_TOKEN,
    SHOPIFY_LOCATION_ID,
  } = process.env;

  // 1) Connect & download
  const client = new ftp.Client(30000);
  await client.access({
    host: FTP_HOST,
    port: parseInt(FTP_PORT, 10),
    user: FTP_USER,
    password: FTP_PASSWORD,
    secure: false,
  });
  const files = await client.list();
  files.sort((a, b) => b.modifiedAt - a.modifiedAt);
  const latest = files[0].name;
  const buffer = await downloadToBuffer(client, latest);
  client.close();

  // 2) Strip BOM & detect XML vs CSV
  let text = buffer.toString("utf8").trim();
  text = text.replace(/^\uFEFF/, "");
  const isXml = text.startsWith("<");

  // 3) Parse into records
  let records;
  if (isXml) {
    // —— XML BRANCH ——
    const productBlocks = text.match(/<Product\b[\s\S]*?<\/Product>/gi) || [];
    records = productBlocks.map(block => {
      const get = (tag) => {
        const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
        return m ? m[1].trim() : "";
      };
      return {
        sku:   get("StockCodeNew"),
        stock: Number(get("FreeStock") || 0),
        cost:  Number(get("Price")     || 0),
        brand: get("Brand"),
        title: get("Description"),
      };
    });
  } else {
    // —— CSV BRANCH ——
    const rows = parse(text, { columns: true, skip_empty_lines: true });
    records = rows.map(r => ({
      sku:   r["/Product/StockCodeNew"].trim(),
      stock: Number(r["/Product/FreeStock"] || 0),
      cost:  Number(r["/Product/Price"]      || 0),
      brand: r["/Product/Brand"].trim(),
      title: r["/Product/Description"].trim(),
    }));
  }

  // 4) Update Shopify
  for (const { sku, stock, cost } of records) {
    await axios.post(
      `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2023-10/inventory_levels/set.json`,
      { inventory_item_id: sku, location_id: SHOPIFY_LOCATION_ID, available: stock },
      { headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN } }
    );
    await axios.put(
      `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2023-10/variants/${sku}.json`,
      { variant: { id: sku, cost: cost } },
      { headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN } }
    );
  }

  console.log(`✅ Synced ${records.length} items`);
}

main().catch(err => {
  console.error("❌ Failed:", err);
  process.exit(1);
});
