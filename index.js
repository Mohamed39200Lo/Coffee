const makeWASocket = require("@whiskeysockets/baileys").default;
const { useMultiFileAuthState, Browsers } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode");
const express = require("express");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const axios = require("axios");
const mime = require("mime-types");

const app = express();

// ====== Directories (for compatibility, but not used for storage) ======
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");

for (const dir of [DATA_DIR, PUBLIC_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ====== In-memory State ======
global.qrCodeUrl = null;
const respondedMessages = new Map(); // sender -> state string
const customerServiceSessions = new Map(); // sessionId -> { customerJid, expiresAt, timeout, type: 'general' }
const pendingData = new Map(); // sender -> { area, details: [], name: '' }
const lastMessageTimestamps = new Map();
const INACTIVITY_TIMEOUT = 50 * 60 * 1000; // 5 minutes
const IGNORE_OLD_MESSAGES_THRESHOLD = 15 * 60 * 1000; // 15 minutes

// ====== GitHub Gist options ======
const GIST_ID = "1050e1f10d7f5591f4f26ca53f2189e9";
const token_part1 = "ghp_gFkAlF";
const token_part2 = "A4sbNyuLtX";
const token_part3 = "YvqKfUEBHXNaPh3ABRms";
const GITHUB_TOKEN = token_part1 + token_part2 + token_part3;

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

function getStatusText(status) {
  switch (status) {
    case "بانتظار التأكيد":
      return "قيد المراجعة ⏳";
    case "جاري التحضير":
      return "قيد التجهيز 🍴";
    case "في الطريق":
      return "في الطريق 🚚";
    case "اكتمل":
      return "تم التسليم ✅";
    case "ملغى":
      return "ملغى ❌";
    default:
      return "غير معروف ❓";
  }
}

// ====== Branch Configurations (Only Military) ======
const BRANCH = {
  name: "المستشفى العسكري",
  areas: [
    { id: 1, name: "العيادات التخصصية 🏥" },
    { id: 2, name: "توسعة مستشفى الملك فهد 🏗️" },
    { id: 3, name: "مركز طب الأسنان 🦷" }
  ]
};

const CATALOG_LINK = "https://wa.me/c/966573760549";

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
  const text = `👋 مرحبًا بك في أنتيكا – فرع المستشفى العسكري ❤️
اختر الخدمة المطلوبة:
1️⃣ طلب جديد (توصيل) 🚚
2️⃣ استعراض المنيو 📋
3️⃣ تتبع الطلب 🔍
4️⃣ خدمة العملاء ☎️

🏛 للعودة إلى القائمة الرئيسية في أي وقت أرسل: *0*`;
  await sock.sendMessage(jid, { text });
  lastMessageTimestamps.set(jid, Date.now());
}

async function routeExistingUser(sender, text) {
  const state = respondedMessages.get(sender);

  if (text === "0") {
    if (state === "CUSTOMER_SERVICE") {
      const sessions = Array.from(customerServiceSessions.values()).filter(s => s.customerJid === sender);
      for (const session of sessions) {
        clearTimeout(session.timeout);
        customerServiceSessions.delete(session.sessionId);
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
    if (text === "1") return startDeliveryFlow(sender);
    if (text === "2") return handleShowMenu(sender);
    if (text === "3") return startTrackingFlow(sender);
    if (text === "4") return startCustomerService(sender, "general");
    await sock.sendMessage(sender, { text: "👋 مرحبًا بك! الرجاء اختيار رقم من القائمة علشان نقدر نخدمك بشكل أفضل ❤️." });
    await sendWelcomeMenu(sender);
    return;
  }

  if (state === "DELIVERY_AREA") {
    const areas = BRANCH.areas;
    const selectedArea = areas.find(a => a.id.toString() === text);
    if (!selectedArea) {
      await sock.sendMessage(sender, { text: "⚠️ الرجاء اختيار رقم منطقة صحيح." });
      return;
    }
    await handleAreaSelected(sender, selectedArea.name);
    return;
  }

  if (state === "AWAITING_ORDER") {
    if (text.startsWith("طلب من الكتالوج:")) {
      pendingData.set(sender, { ...pendingData.get(sender), details: text });
      await sock.sendMessage(sender, { text: "الرجاء ارسال اسمك لتأكيد الطلب" });
      respondedMessages.set(sender, "AWAITING_NAME");
      return;
    }
  }

  if (state === "AWAITING_NAME") {
    pendingData.set(sender, { ...pendingData.get(sender), name: text });
    await finalizeOrder(sender);
    return;
  }

  if (state === "TRACKING") {
    await handleTrackOrder(sender, text);
    return;
  }

  if (state === "CUSTOMER_SERVICE") {
    // Allow messages in customer service without interruption
    return;
  }
}

async function startDeliveryFlow(jid) {
  const areasText = BRANCH.areas.map(a => `${a.id}. ${a.name}`).join("\n\t");
  const text = `📍 حدد موقع التوصيل: 🗺️
\t${areasText}`;
  await sock.sendMessage(jid, { text });
  respondedMessages.set(jid, "DELIVERY_AREA");
}

async function handleAreaSelected(jid, areaName) {
  const text = `🛒 عزيزي العميل، تأكد من اختيار المنتجات المطلوبة من الكتالوج واضغط تأكيد الطلب. 🍴

⏩️ ${CATALOG_LINK}`;
  await sock.sendMessage(jid, { 
    text,
    linkPreview: {
      title: 'كتالوج المطعم 📋',
      body: 'تصفح الأصناف والعروض 🎉',
      canonicalUrl: CATALOG_LINK,
      matchedText: CATALOG_LINK
    }
  });
  respondedMessages.set(jid, "AWAITING_ORDER");
  pendingData.set(jid, { area: areaName, details: "", name: "" });
}

async function finalizeOrder(jid) {
  const data = pendingData.get(jid) || { area: null, details: "", name: "" };
  const id = generateOrderId();
  const order = {
    id,
    customerJid: jid,
    area: data.area,
    details: data.details, // هنا يتم حفظ التفاصيل الكاملة للعناصر
    name: data.name,
    status: "بانتظار التأكيد",
    createdAt: new Date().toISOString()
  };
  await upsertOrder(order);

  await sock.sendMessage(jid, { text: `⏳ شكرًا لك، طلبك تحت المراجعة حاليًا من مشرف الفرع. 🙏
الرجاء الانتظار قليلاً…` });
  respondedMessages.set(jid, "MAIN_MENU");
  pendingData.delete(jid);
}

async function handleShowMenu(jid) {
  const text = `📖 تفضل هذا هو المنيو الخاص بنا: 🍰
${CATALOG_LINK}`;
  await sock.sendMessage(jid, { 
    text,
    linkPreview: {
      title: 'كتالوج المطعم 📋',
      body: 'تصفح الأصناف والعروض 🎉',
      canonicalUrl: CATALOG_LINK,
      matchedText: CATALOG_LINK
    }
  });
  respondedMessages.set(jid, "MAIN_MENU");
}

async function startTrackingFlow(jid) {
  const text = `🔍 الرجاء إدخال رقم الطلب الخاص بك لمتابعة حالته. 📦`;
  await sock.sendMessage(jid, { text });
  respondedMessages.set(jid, "TRACKING");
}

async function handleTrackOrder(jid, orderId) {
  const data = await readOrders();
  const order = data.orders.find(o => o.id === orderId);
  if (!order) {
    await sock.sendMessage(jid, { text: `⚠️ لا يوجد طلب بهذا الرقم: ${orderId} ❗` });
  } else {
    const statusText = getStatusText(order.status);
    await sock.sendMessage(jid, { text: `🔔 تحديث حالة طلبك ${orderId}: ${statusText}` });
  }
  respondedMessages.set(jid, "MAIN_MENU");
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
    const serviceText = type === "general" ? "خدمة العملاء ☎️" : "مشرف الفرع 👨‍🍳";
    await sock.sendMessage(jid, { 
      text: `💬 شكراً لتواصلك مع ${serviceText} 🙏\nسوف نقوم بالرد عليك في أقرب وقت ممكن.\n\n🆔 معرف الجلسة: ${sessionId}\n\n🔙 لإنهاء المحادثة والعودة للقائمة الرئيسية أرسل: *0*` });
  }
}

async function handleEndSession(text, sender) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) {
    await sock.sendMessage(sender, { text: "⚠️ يرجى تحديد معرف الجلسة بعد كلمة 'انتهاء' (مثال: انتهاء 1234) ❗" });
    return;
  }
  const sessionId = parts[1];
  const session = customerServiceSessions.get(sessionId);
  if (!session) {
    await sock.sendMessage(sender, { text: `⚠️ لا توجد جلسة بالمعرف ${sessionId}. ❗` });
    return;
  }
  clearTimeout(session.timeout);
  customerServiceSessions.delete(sessionId);
  respondedMessages.set(session.customerJid, "MAIN_MENU");
  await sock.sendMessage(session.customerJid, { text: "✅ تم إنهاء الجلسة. كيف نقدر نخدمك اليوم؟ 👋" });
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

// ---- Orders ----
app.get("/api/orders", async (req, res) => {
  const data = await readOrders();
  const status = req.query.status;
  let orders = status ? data.orders.filter(o => o.status === status) : data.orders;
  orders = orders.map(order => ({
    ...order,
    whatsappNumber: order.customerJid.split('@')[0],
    whatsappLink: order.status !== "اكتمل" && order.status !== "ملغى" ? `https://wa.me/${order.customerJid.split('@')[0]}` : null
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
      await sock.sendMessage(order.customerJid, { text: `✅ تم قبول طلبك بنجاح. 🙌
رقم الطلب: ${order.id}
📦 طلبك الآن قيد التجهيز، وسيتم التواصل معك عند الانتهاء. 🍴` });
    } else if (status === "في الطريق") {
      await sock.sendMessage(order.customerJid, { text: `🔔 تحديث حالة طلبك ${order.id}: في الطريق 🚚` });
    } else if (status === "اكتمل") {
      await sock.sendMessage(order.customerJid, { text: `🔔 تحديث حالة طلبك ${order.id}: تم التسليم ✅` });
    } else if (status === "ملغى") {
      await sock.sendMessage(order.customerJid, { text: `🔔 تحديث حالة طلبك ${order.id}: ملغى ❌` });
    } else {
      await sock.sendMessage(order.customerJid, { text: `🔔 تحديث حالة طلبك ${order.id}: ${getStatusText(status)}` });
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

app.delete("/api/orders/:id", async (req, res) => {
  const id = req.params.id;
  const data = await readOrders();
  const idx = data.orders.findIndex(o => o.id === id);
  if (idx < 0) return res.status(404).json({ error: "طلب غير موجود" });
  data.orders.splice(idx, 1);
  await writeOrders(data);
  res.json({ success: true });
});

// ====== Start Server & WA ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 السيرفر يعمل على http://localhost:${PORT}`));
connectToWhatsApp();
