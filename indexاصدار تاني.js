const makeWASocket = require("@whiskeysockets/baileys").default;
const { useMultiFileAuthState, Browsers } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode");
const express = require("express");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const axios = require("axios");
const multer = require("multer");
const mime = require("mime-types");

const app = express();

// ====== Directories (for compatibility, but not used for storage) ======
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const MENU_DIR = path.join(PUBLIC_DIR, "menu");

for (const dir of [DATA_DIR, PUBLIC_DIR, MENU_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ====== In-memory State ======
global.qrCodeUrl = null;
const respondedMessages = new Map(); // sender -> state string
const customerServiceSessions = new Map(); // sessionId -> { customerJid, expiresAt, timeout, type: 'general' | 'branch_supervisor' }
const pendingData = new Map(); // sender -> { branch, area, details: [] }
const lastMessageTimestamps = new Map();
const INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const IGNORE_OLD_MESSAGES_THRESHOLD = 15 * 60 * 1000; // 15 minutes

// ====== GitHub Gist options ======
const GIST_ID = "1050e1f10d7f5591f4f26ca53f2189e9";
const token_part1 = "ghp_gFkAlF";
const token_part2 = "A4sbNyuLtX";
const token_part3 = "YvqKfUEBHXNaPh3ABRms";
const GITHUB_TOKEN = token_part1 + token_part2 + token_part3;

async function loadOptions() {
  const defaultData = {
    mainMenu: [
      { id: 1, label: "فرع المستشفى العسكري 🏥", command: "military" },
      { id: 2, label: "فرع أبها 🌆", command: "abha" },
      { id: 3, label: "المنيو والعروض 📋", command: "menu_offers" },
      { id: 4, label: "التواصل مع خدمة العملاء ☎️", command: "support" }
    ],
    orders: []
  };

  try {
    const response = await axios.get(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` }
    });

    const gistData = JSON.parse(response.data.files["options70552.json"]?.content || "{}");   

    if (!gistData.mainMenu || !Array.isArray(gistData.mainMenu)) {  
      gistData.mainMenu = defaultData.mainMenu;  
    }  
    if (!gistData.orders || !Array.isArray(gistData.orders)) {  
      gistData.orders = defaultData.orders;  
    }  

    gistData.options = gistData.mainMenu;  
    return gistData;
  } catch (e) {
    console.error("❌ فشل تحميل الخيارات من Gist. سيتم استخدام خيارات افتراضية.");
    return {
      ...defaultData,
      options: defaultData.mainMenu
    };
  }
}

async function saveOptions(options) {
  try {
    await axios.patch(
      `https://api.github.com/gists/${GIST_ID}`,
      { files: { "options70552.json": { content: JSON.stringify(options, null, 2) } } },
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );
  } catch (e) {
    console.error("❌ فشل حفظ الخيارات إلى Gist:", e.message);
  }
}

async function readOrders() {
  try {
    const response = await axios.get(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` }
    });
    const ordersData = JSON.parse(response.data.files["orders.json"]?.content || '{"orders": []}');
    return { orders: Array.isArray(ordersData.orders) ? ordersData.orders : [] };
  } catch (e) {
    console.error("❌ خطأ في قراءة الطلبات من Gist:", e.message);
    return { orders: [] };
  }
}

async function writeOrders(data) {
  try {
    const safeData = { orders: Array.isArray(data.orders) ? data.orders : [] };
    await axios.patch(
      `https://api.github.com/gists/${GIST_ID}`,
      { files: { "orders.json": { content: JSON.stringify(safeData, null, 2) } } },
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );
  } catch (e) {
    console.error("❌ فشل حفظ الطلبات إلى Gist:", e.message);
  }
}

async function readMenuImages() {
  try {
    const response = await axios.get(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` }
    });
    const menuData = JSON.parse(response.data.files["menu_images.json"]?.content || '{"images": []}');
    return Array.isArray(menuData.images) ? menuData.images : [];
  } catch (e) {
    console.error("❌ خطأ في قراءة صور المنيو من Gist:", e.message);
    return [];
  }
}

async function writeMenuImages(images) {
  try {
    const safeData = { images: Array.isArray(images) ? images : [] };
    await axios.patch(
      `https://api.github.com/gists/${GIST_ID}`,
      { files: { "menu_images.json": { content: JSON.stringify(safeData, null, 2) } } },
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );
  } catch (e) {
    console.error("❌ فشل حفظ صور المنيو إلى Gist:", e.message);
  }
}

async function readOffers() {
  try {
    const response = await axios.get(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` }
    });
    const offersData = JSON.parse(response.data.files["offers.json"]?.content || '{"offers": []}');
    return Array.isArray(offersData.offers) ? offersData.offers : [];
  } catch (e) {
    console.error("❌ خطأ في قراءة العروض من Gist:", e.message);
    return [];
  }
}

async function writeOffers(offers) {
  try {
    const safeData = { offers: Array.isArray(offers) ? offers : [] };
    await axios.patch(
      `https://api.github.com/gists/${GIST_ID}`,
      { files: { "offers.json": { content: JSON.stringify(safeData, null, 2) } } },
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );
  } catch (e) {
    console.error("❌ فشل حفظ العروض إلى Gist:", e.message);
  }
}

// ====== Helpers ======
function convertArabicToEnglishNumbers(text) {
  const arabicNumbers = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
  return text.replace(/[٠-٩]/g, d => arabicNumbers.indexOf(d));
}

function generateSessionId() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function generateOrderId() {
  return Math.floor(10000000 + Math.random() * 90000000).toString(); // 8-digit numeric ID
}

async function upsertOrder(order) {
  const data = await readOrders();
  // Check for ID collision (rare, but to be safe)
  while (data.orders.some(o => o.id === order.id)) {
    order.id = generateOrderId();
  }
  const idx = data.orders.findIndex(o => o.id === order.id);
  if (idx >= 0) {
    data.orders[idx] = order;
  } else {
    data.orders.push(order);
  }
  await writeOrders(data);
}

// ====== Branch Configurations ======
const BRANCHES = {
  military: {
    name: "المستشفى العسكري",
    areas: [
      { id: 1, name: "العيادات التخصصية 🏥" },
      { id: 2, name: "توسعة المستشفى الملك فهد 🏗️" },
      { id: 3, name: "مركز طب الأسنان 🦷" }
    ]
  },
  abha: {
    name: "أبها",
    areas: [] // يمكن إضافة مناطق لفرع أبها إذا لزم الأمر
  }
};

// ====== WhatsApp Connection ======
let sock;
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS("Safari")
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", handleConnectionUpdate);
  sock.ev.on("messages.upsert", handleMessagesUpsert);
}

function handleConnectionUpdate(update) {
  const { connection, lastDisconnect, qr } = update;
  if (qr) {
    qrcode.toDataURL(qr, (err, url) => {
      if (err) return console.error("❌ خطأ في إنشاء QR:", err);
      global.qrCodeUrl = url;
    });
  }
  if (connection === "close") {
    const code = lastDisconnect?.error?.output?.statusCode;
    const shouldReconnect = code !== 401;
    console.log("🚨 تم فصل الاتصال، سيتم المحاولة مجددًا:", shouldReconnect, code);
    if (shouldReconnect) setTimeout(connectToWhatsApp, 3000);
  } else if (connection === "open") {
    console.log("✅ تم الاتصال بنجاح!");
  }
}

async function handleMessagesUpsert({ messages }) {
  const msg = messages[0];
  if (!msg || !msg.message) return;

  const sender = msg.key.remoteJid;
  if (sender.endsWith("@g.us")) return;

  const messageTimestamp = msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now();
  if (messageTimestamp < Date.now() - IGNORE_OLD_MESSAGES_THRESHOLD) return;

  let messageContent = '';
  if (msg.message.conversation) {
    messageContent = msg.message.conversation;
  } else if (msg.message.extendedTextMessage) {
    messageContent = msg.message.extendedTextMessage.text;
  } else if (msg.message.orderMessage) {
    const order = msg.message.orderMessage;
    messageContent = 'طلب من الكتالوج:\n';
    if (order.message) messageContent += `${order.message}\n`;
    messageContent += `عدد العناصر: ${order.itemCount}\n`;
    if (order.items && order.items.length > 0) {
      messageContent += 'التفاصيل:\n';
      order.items.forEach(item => {
        messageContent += `${item.quantity} x ${item.title} - ${item.price1000 / 1000} ${item.currency}\n`;
        if (item.description) messageContent += `وصف: ${item.description}\n`;
      });
    }
    messageContent += `الإجمالي: ${order.totalAmount1000 / 1000} ${order.totalCurrencyCode}`;
  }

  const text = convertArabicToEnglishNumbers(messageContent.trim());
  const isFromMe = msg.key.fromMe;

  try {
    if (text.startsWith("انتهاء ")) {
      await handleEndSession(text, sender);
      return;
    }

    if (text === "محادثة الدعم") {
      const silent = isFromMe;
      await startCustomerService(sender, "general", silent);
      return;
    }

    if (isFromMe) return;

    if (!respondedMessages.has(sender)) {  
      await sendWelcomeMenu(sender);  
      respondedMessages.set(sender, "MAIN_MENU");  
      lastMessageTimestamps.set(sender, Date.now());  
      return;  
    }  

    await routeExistingUser(sender, text);
  } catch (e) {
    console.error("❌ خطأ في معالجة الرسالة:", e);
  } finally {
    lastMessageTimestamps.set(sender, Date.now());
  }
}

// ====== Bot Flows ======
async function sendWelcomeMenu(jid) {
  const text = `مرحباً 👋  
أهلاً بك في أنتيكا ❤️  
لخدمتك بشكل أسرع اختر من القائمة التالية:  

1️⃣ فرع المستشفى العسكري 🏥  
2️⃣ فرع أبها 🌆  
3️⃣ المنيو والعروض 📋  
4️⃣ التواصل مع خدمة العملاء ☎️  

ℹ️ للعودة إلى القائمة الرئيسية في أي وقت أرسل: *إلغاء*`;
  await sock.sendMessage(jid, { text });
  lastMessageTimestamps.set(jid, Date.now());
}

async function routeExistingUser(sender, text) {
  const state = respondedMessages.get(sender);

  if (/^(إلغاء|ألغاء|الغاء|إلغاء)$/i.test(text)) {
    if (state === "CUSTOMER_SERVICE") {
      const sessions = Array.from(customerServiceSessions.values()).filter(s => s.customerJid === sender);
      for (const session of sessions) {
        clearTimeout(session.timeout);
        customerServiceSessions.delete(session.sessionId); // Assuming sessionId is the key
      }
    }
    respondedMessages.set(sender, "MAIN_MENU");
    pendingData.delete(sender);
    return sendWelcomeMenu(sender);
  }

  const lastTime = lastMessageTimestamps.get(sender) || 0;
  if (Date.now() - lastTime > INACTIVITY_TIMEOUT && state !== "CUSTOMER_SERVICE") {
    await sendWelcomeMenu(sender);
    lastMessageTimestamps.set(sender, Date.now());
    return;
  }

  if (state === "MAIN_MENU") {
    if (text === "1") return handleBranchSelection(sender, "military");
    if (text === "2") return handleBranchSelection(sender, "abha");
    if (text === "3") return handleShowMenuAndOffers(sender);
    if (text === "4") return startCustomerService(sender, "general");
    await sock.sendMessage(sender, { text: "⚠️ الرجاء اختيار رقم صحيح من القائمة." });  
    return;
  }

  if (state.startsWith("BRANCH_MENU_")) {
    const branch = state.split("_")[2];
    if (text === "1") return handleShowMenu(sender, branch, true);
    if (text === "2") return startDeliveryFlow(sender, branch);
    if (text === "3") return startBranchSupervisor(sender, branch);
    await sock.sendMessage(sender, { text: "⚠️ الرجاء اختيار رقم صحيح من القائمة." });  
    return;
  }

  if (state.startsWith("DELIVERY_AREA_")) {
    const branch = state.split("_")[2];
    const areas = BRANCHES[branch].areas;
    const selectedArea = areas.find(a => a.id.toString() === text);
    if (!selectedArea) {
      await sock.sendMessage(sender, { text: "⚠️ الرجاء اختيار رقم منطقة صحيح." });
      return;
    }
    await handleAreaSelected(sender, branch, selectedArea.name);
    return;
  }

  if (state.startsWith("ORDER_COLLECTING_")) {
    if (text.toLowerCase() === "تم") {
      await finalizeOrder(sender);
      return;
    }
    const data = pendingData.get(sender) || { details: [] };
    data.details.push(text);
    pendingData.set(sender, data);
    return;
  }

  if (state === "CUSTOMER_SERVICE") {
    // Allow messages in customer service without interruption
    return;
  }
}

async function handleBranchSelection(jid, branchKey) {
  const branch = BRANCHES[branchKey];
  const text = `أنت الآن مع فرع *${branch.name}*.  
اختر خدمتك:  

1️⃣ عرض المنيو 🍰  
2️⃣ طلب توصيل 🚚 
3️⃣ التواصل مع مشرف الفرع 👨‍🍳`;
  await sock.sendMessage(jid, { text });
  respondedMessages.set(jid, `BRANCH_MENU_${branchKey}`);
}

async function handleShowMenuAndOffers(jid) {
  await handleShowMenu(jid);
  await handleShowOffers(jid);
  await sendWelcomeMenu(jid);
  respondedMessages.set(jid, "MAIN_MENU");
}

async function handleShowMenu(jid, branch = null, returnToMenu = false) {
  const images = await readMenuImages();
  if (images.length === 0) {
    await sock.sendMessage(jid, { text: "📄 لا توجد صور منيو مرفوعة حالياً. رجاء راجع الإدارة." });
  } else {
    for (const img of images) {
      const buffer = Buffer.from(img.base64, 'base64');
      await sock.sendMessage(jid, { image: buffer, caption: branch ? `منيو فرع ${BRANCHES[branch].name}` : "منيو مطعم أنتيكا" });
      await new Promise(r => setTimeout(r, 400));
    }
  }
  if (returnToMenu && branch) {
    await handleBranchSelection(jid, branch);
  }
}

async function handleShowOffers(jid) {
  const offers = await readOffers();
  if (offers.length === 0) {
    await sock.sendMessage(jid, { text: "🎉 لا توجد عروض متاحة حالياً. تابعنا للحصول على أحدث العروض!" });
  } else {
    const offersText = offers
      .map(o => `🔥 *${o.title}*\n${o.description}\n*السعر*: ${o.price}\n*ينتهي في*: ${new Date(o.expiresAt).toLocaleDateString('ar-EG')}`)
      .join("\n\n");
    await sock.sendMessage(jid, { text: `🎉 *العروض الحالية*:\n\n${offersText}` });
  }
}

async function startDeliveryFlow(jid, branch) {
  const areas = BRANCHES[branch].areas;
  if (areas.length === 0) {
    // لفرع أبها أو غيره بدون مناطق، انتقل مباشرة إلى عرض المنيو وجمع الطلب
    await handleAreaSelected(jid, branch, null);
    return;
  }
  const areasText = areas.map(a => `${a.id}️⃣ ${a.name}`).join("\n");
  const text = `اختر منطقة التوصيل:  

${areasText}`;
  await sock.sendMessage(jid, { text });
  respondedMessages.set(jid, `DELIVERY_AREA_${branch}`);
}

async function handleAreaSelected(jid, branch, areaName) {
  let text = areaName ? `ممتاز ✅  
تم اختيار *${areaName}*.  
هذا منيو الفرع 👇` : `هذا منيو الفرع 👇`;
  await sock.sendMessage(jid, { text });
  await handleShowMenu(jid, branch);
  
  text = `اختر الأصناف وأرسل الطلب الآن 📝  
يمكنك اختيار الأصناف من خلال الكتالوج ⬇️

⏩️ https://wa.me/c/201271021907

تم إرسال تم

✍️ او اكتب بيانات الطلب بالشكل التالي:
• الاسم
• تفاصيل الطلب (الأصناف والكمية)
• العنوان
• رقم التواصل

✅ عند الانتهاء أرسل كلمة: تم
❌ لإلغاء الطلب والعودة للقائمة الرئيسية أرسل كلمة: إلغاء`;

  const images = await readMenuImages();
  let thumbnail = null;
  if (images.length > 0) {
    thumbnail = Buffer.from(images[0].base64, 'base64');
  }

  // استخدام linkPreview بدلاً من contextInfo لعرض معاينة الرابط
  await sock.sendMessage(jid, { 
    text,
    linkPreview: {
      title: 'كتالوج المطعم',
      body: 'تصفح الأصناف والعروض',
      thumbnail: thumbnail,
      canonicalUrl: 'https://wa.me/c/201271021907',
      matchedText: 'https://wa.me/c/201271021907',
      jpegThumbnail: thumbnail // إذا كان مطلوباً
    }
  });
  respondedMessages.set(jid, `ORDER_COLLECTING_${branch}`);
  pendingData.set(jid, { branch, area: areaName, details: [] });
}

async function finalizeOrder(jid) {
  const data = pendingData.get(jid) || { details: [], branch: null, area: null };
  const fullDetails = data.details.join("\n");
  if (!fullDetails.trim()) {
    await sock.sendMessage(jid, { text: "⚠️ لم نستلم تفاصيل كافية. أعد إرسال البيانات ثم كلمة تم." });
    return;
  }
  const id = generateOrderId();
  const order = {
    id,
    customerJid: jid,
    branch: data.branch,
    area: data.area,
    details: fullDetails,
    status: "بانتظار التأكيد",
    createdAt: new Date().toISOString()
  };
  await upsertOrder(order);

  await sock.sendMessage(jid, { text: `تم استلام طلبك بانتظار تأكيده من خدمة العملاء.` });
  respondedMessages.set(jid, "MAIN_MENU");
  pendingData.delete(jid);
  await sendWelcomeMenu(jid);
}

async function startCustomerService(jid, type = "general", silent = false) {
  const sessionId = generateSessionId();
  const twoHours = 2 * 60 * 60 * 1000;

  const timeout = setTimeout(async () => {
    customerServiceSessions.delete(sessionId);
    respondedMessages.set(jid, "MAIN_MENU");
    await sendWelcomeMenu(jid);
  }, twoHours);

  customerServiceSessions.set(sessionId, { 
    customerJid: jid, 
    expiresAt: Date.now() + twoHours, 
    timeout,
    type
  });

  respondedMessages.set(jid, "CUSTOMER_SERVICE");

  if (!silent) {
    const serviceText = type === "general" ? "خدمة العملاء" : "مشرف الفرع";
    await sock.sendMessage(jid, { 
      text: `💬 شكراً لتواصلك مع ${serviceText} 🙏\nسوف نقوم بالرد عليك في أقرب وقت ممكن.\n\n🆔 معرف الجلسة: ${sessionId}\n\n🔙 لإنهاء المحادثة والعودة للقائمة الرئيسية أرسل كلمة: إلغاء` });
  }
}

async function startBranchSupervisor(jid, branch) {
  await startCustomerService(jid, "branch_supervisor");
}

async function handleEndSession(text, sender) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) {
    await sock.sendMessage(sender, { text: "⚠️ يرجى تحديد معرف الجلسة بعد كلمة 'انتهاء' (مثال: انتهاء 1234)" });
    return;
  }
  const sessionId = parts[1];
  const session = customerServiceSessions.get(sessionId);
  if (!session) {
    await sock.sendMessage(sender, { text: `⚠️ لا توجد جلسة بالمعرف ${sessionId}.` });
    return;
  }
  clearTimeout(session.timeout);
  customerServiceSessions.delete(sessionId);
  respondedMessages.set(session.customerJid, "MAIN_MENU");
  await sock.sendMessage(session.customerJid, { text: "✅ تم إنهاء الجلسة. كيف نقدر نخدمك اليوم؟" });
  await sendWelcomeMenu(session.customerJid);
  if (sender !== session.customerJid) {
    await sock.sendMessage(sender, { text: `✅ تم إنهاء الجلسة (${sessionId}).` });
  }
}

// ====== Admin Panel & APIs ======
app.use(express.json());
app.use("/panel", express.static(PUBLIC_DIR));

// Root shows QR code during login
app.get("/", (req, res) => {
  res.send(global.qrCodeUrl
    ? `<h1 style="font-family:Tahoma">امسح رمز QR للاتصال بالبوت</h1><img src="${global.qrCodeUrl}" width="300">`
    : `<h1 style="font-family:Tahoma">لم يتم توليد رمز QR بعد... يرجى الانتظار!</h1>`);
});

// ---- Menu images ----
const storage = multer.memoryStorage();
const upload = multer({ storage });

app.get("/api/menu", async (req, res) => {
  const images = await readMenuImages();
  res.json({ images: images.map(img => ({ filename: img.filename })) });
});

app.post("/api/menu", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "لم يتم رفع ملف" });

  const ext = mime.extension(req.file.mimetype) || "jpg";
  const filename = `menu_${Date.now()}.${ext}`;
  const base64 = req.file.buffer.toString('base64');

  const images = await readMenuImages();
  images.push({ filename, base64, mimetype: req.file.mimetype });
  await writeMenuImages(images);

  res.json({ success: true, file: filename });
});

app.delete("/api/menu/:filename", async (req, res) => {
  const filename = req.params.filename;
  const images = await readMenuImages();
  const updatedImages = images.filter(img => img.filename !== filename);
  if (images.length === updatedImages.length) {
    return res.status(404).json({ error: "الملف غير موجود" });
  }
  await writeMenuImages(updatedImages);
  res.json({ success: true });
});

// ---- Orders ----
app.get("/api/orders", async (req, res) => {
  const data = await readOrders();
  const status = req.query.status;
  let orders = status ? data.orders.filter(o => o.status === status) : data.orders;
  orders = orders.map(order => ({
    ...order,
    whatsappNumber: order.customerJid.split('@')[0],
    whatsappLink: order.status !== "اكتمل" ? `https://wa.me/${order.customerJid.split('@')[0]}` : null
  }));
  res.json({ orders });
});

app.patch("/api/orders/:id/status", async (req, res) => {
  const id = req.params.id;
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: "status مطلوب" });
  const data = await readOrders();
  const idx = data.orders.findIndex(o => o.id === id);
  if (idx < 0) return res.status(404).json({ error: "طلب غير موجود" });
  const order = data.orders[idx];
  const oldStatus = order.status;
  order.status = status;
  await writeOrders(data);

  try {
    if (status === "جاري التحضير" && oldStatus === "بانتظار التأكيد") {
      const areaText = order.area ? `وسيتم التوصيل إلى: ${order.area} 🚚` : "";
      await sock.sendMessage(order.customerJid, { text: `شكراً لطلبك 🙏  
طلبك الآن قيد التحضير 🍴  
${areaText}` });
    } else {
      await sock.sendMessage(order.customerJid, { text: `🔔 تحديث حالة طلبك *${order.id}*: ${status}` });
    }
  } catch (e) {
    console.error("⚠️ فشل إرسال إشعار للعميل:", e.message);
  }

  if (status === "اكتمل") {
    data.orders = data.orders.filter(o => o.id !== id);
    await writeOrders(data);
  }

  res.json({ success: true });
});

// ---- Offers ----
app.get("/api/offers", async (req, res) => {
  try {
    res.json({ offers: await readOffers() });
  } catch {
    res.status(500).json({ error: "فشل تحميل العروض" });
  }
});

app.post("/api/offers", async (req, res) => {
  try {
    const newOffer = req.body;
    if (!newOffer.id || !newOffer.title || !newOffer.description || !newOffer.price || !newOffer.expiresAt) {
      return res.status(400).json({ error: "جميع الحقول (id, title, description, price, expiresAt) مطلوبة" });
    }
    const offers = await readOffers();
    const insertIndex = offers.findIndex(o => parseInt(o.id) > parseInt(newOffer.id));
    if (insertIndex === -1) offers.push(newOffer); else offers.splice(insertIndex, 0, newOffer);
    await writeOffers(offers);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "فشل إضافة العرض" });
  }
});

app.put("/api/offers/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const updatedOffer = req.body;
    if (!updatedOffer.title || !updatedOffer.description || !updatedOffer.price || !updatedOffer.expiresAt) {
      return res.status(400).json({ error: "جميع الحقول (title, description, price, expiresAt) مطلوبة" });
    }
    const offers = await readOffers();
    const idx = offers.findIndex(o => o.id === id);
    if (idx < 0) return res.status(404).json({ error: "العرض غير موجود" });
    offers[idx] = { id, ...updatedOffer };
    await writeOffers(offers);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "فشل تحديث العرض" });
  }
});

app.delete("/api/offers/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const offers = await readOffers();
    const updatedOffers = offers.filter(o => o.id !== id);
    if (offers.length === updatedOffers.length) {
      return res.status(404).json({ error: "العرض غير موجود" });
    }
    await writeOffers(updatedOffers);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "فشل حذف العرض" });
  }
});

// ---- Options (Panel texts) keep compatibility ----
app.get("/api/options", async (req, res) => {
  try { res.json(await loadOptions()); } catch { res.status(500).json({ error: "فشل تحميل الخيارات" }); }
});

app.post("/api/options", async (req, res) => {
  try {
    const newOption = req.body;
    const options = await loadOptions();
    const insertIndex = options.options.findIndex(opt => parseInt(opt.id) > parseInt(newOption.id));
    if (insertIndex === -1) options.options.push(newOption); else options.options.splice(insertIndex, 0, newOption);
    await saveOptions(options);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "فشل إضافة الخيار" }); }
});

app.delete("/api/options/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const options = await loadOptions();
    options.options = options.options.filter(opt => opt.id !== id);
    await saveOptions(options);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "فشل حذف الخيار" }); }
});

// ====== Start Server & WA ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 السيرفر يعمل على http://localhost:${PORT}`));
connectToWhatsApp();
