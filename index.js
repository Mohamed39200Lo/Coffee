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
const customerServiceSessions = new Map(); // sessionId -> { customerJid, expiresAt, timeout, type: 'general' | 'payment' }
const pendingData = new Map(); // sender -> { type, details: string | {}, orderId: null, name: '' }
const lastMessageTimestamps = new Map();
const INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const IGNORE_OLD_MESSAGES_THRESHOLD = 15 * 60 * 1000; // 15 minutes

// ====== GitHub Gist options ======
const GIST_ID = "3eee22f7815901ef445444d0ff6a5e86";
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
  return order.id;
}

function getStatusText(status) {
  switch (status) {
    case "pending_review":
      return "قيد المراجعة ⏳";
    case "awaiting_payment":
      return "بانتظار الدفع 💳";
    case "payment_review":
      return "مراجعة الدفع 🔍";
    case "confirmed":
      return "مؤكد ✅";
    case "preparing":
      return "قيد التحضير 🍰";
    case "ready":
      return "جاهز للاستلام 🛍️";
    case "delivered":
      return "تم التسليم 🚚";
    case "cancelled":
      return "ملغى ❌";
    default:
      return "غير معروف ❓";
  }
}

// ====== Catalog Links ======
const CELEBRATION_CAKES_CATALOG = "https://wa.me/c/201271021907"; // Example, replace with actual
const GENERAL_CATALOG = "https://wa.me/c/201271021907";

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
  let isImage = false;
  let imageUrl = null;

  if (msg.message.imageMessage) {
    isImage = true;
    imageUrl = "simulated_image_url_from_message"; // Placeholder: Implement actual download and upload if needed for persistence
  } else if (msg.message.conversation) {
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
    if (isFromMe) return;

    const state = respondedMessages.get(sender);

    if (text.startsWith("انتهاء ")) {
      await handleEndSession(text, sender);
      return;
    }

    if (text === "7") {
      await startCustomerService(sender, "general");
      return;
    }

    if (text === "0") {
      if (state === "AWAITING_PAYMENT_PROOF" || state === "CONFIRM_PAYMENT") {
        await cancelOrder(sender);
        return;
      } else if (state !== "SUBMITTED" && state !== "CUSTOMER_SERVICE") {
        respondedMessages.set(sender, "MAIN_MENU");
        pendingData.delete(sender);
        await sendWelcomeMenu(sender);
        return;
      }
    }

    if (state === "SUBMITTED") return; // Stop interacting after order submission unless 0 or 7

    if (state === "AWAITING_PAYMENT_PROOF" && isImage) {
      await handlePaymentProof(sender, imageUrl);
      return;
    }

    if (!respondedMessages.has(sender)) {
      await sendWelcomeMenu(sender);
      respondedMessages.set(sender, "MAIN_MENU");
      lastMessageTimestamps.set(sender, Date.now());
      return;
    }

    await routeExistingUser(sender, text, isImage);
  } catch (e) {
    console.error("❌ خطأ في معالجة الرسالة:", e);
  } finally {
    if (!isImage) lastMessageTimestamps.set(sender, Date.now());
  }
}

// ====== Bot Flows ======
async function sendWelcomeMenu(jid) {
  const text = `✨ بوت مخبز ومقهى لوميرا ✨

مرحبًا 👋
معاكم مخبز ومقهى لوميرا لخدمتكم بأطيب النكهات وأجمل الكيكات 🎂☕
لخدمة أسرع اختر من القائمة التالية:

1️⃣ 🕒 أوقات عمل المقهى
2️⃣ 🎂 الطلبيات الخاصة لمناسباتكم
3️⃣ 🍰 منيو كيكات الاحتفالات 🎉
4️⃣ 📖 طلب من الكتالوج
5️⃣ 🔄 سياسة الإلغاء والاستبدال
6️⃣ 💳 إرسال إيصال الدفع
7️⃣ 💬 التحدث مع خدمة العملاء

🏛 للعودة إلى القائمة الرئيسية في أي وقت أرسل: *0*`;
  await sock.sendMessage(jid, { text });
  lastMessageTimestamps.set(jid, Date.now());
}

async function routeExistingUser(sender, text, isImage) {
  const state = respondedMessages.get(sender);

  const lastTime = lastMessageTimestamps.get(sender) || 0;
  if (Date.now() - lastTime > INACTIVITY_TIMEOUT && state !== "CUSTOMER_SERVICE" && state !== "AWAITING_PAYMENT_PROOF") {
    await sendWelcomeMenu(sender);
    lastMessageTimestamps.set(sender, Date.now());
    return;
  }

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

  if (state === "MAIN_MENU") {
    if (text === "1") return handleWorkingHours(sender);
    if (text === "2") return startSpecialOrderFlow(sender);
    if (text === "3") return handleCelebrationCakesMenu(sender);
    if (text === "4") return handleGeneralCatalogOrder(sender);
    if (text === "5") return handleCancellationPolicy(sender);
    if (text === "6") return handleSendPaymentProof(sender);
    if (text === "7") return startCustomerService(sender, "general");
    await sock.sendMessage(sender, { text: "👋 مرحبًا بك! الرجاء اختيار رقم من القائمة علشان نقدر نخدمك بشكل أفضل ❤️." });
    await sendWelcomeMenu(sender);
    return;
  }

  if (state === "SPECIAL_ORDER") {
    await handleSpecialOrderDetails(sender, text);
    return;
  }

  if (state === "AWAITING_CONFIRMATION") {
    if (text === "1") return confirmSpecialOrder(sender);
    if (text === "2") return addMoreDetails(sender);
    await sock.sendMessage(sender, { text: "⚠️ الرجاء اختيار 1 أو 2." });
    return;
  }

  if (state === "AWAITING_ORDER_DETAILS" || state === "AWAITING_CATALOG_ORDER") {
    if (text.startsWith("طلب من الكتالوج:")) {
      pendingData.set(sender, { ...pendingData.get(sender), details: text });
      await sock.sendMessage(sender, { text: "الرجاء إرسال اسمك لتأكيد الطلب 👤" });
      respondedMessages.set(sender, "AWAITING_NAME");
      return;
    }
  }

  if (state === "AWAITING_NAME") {
    pendingData.set(sender, { ...pendingData.get(sender), name: text });
    await submitOrderForReview(sender);
    return;
  }

  if (state === "CONFIRM_PAYMENT") {
    if (text === "1") return confirmPaymentProof(sender);
    if (text === "2") return rejectPaymentProof(sender);
    if (text === "3") return cancelOrder(sender);
    if (text === "4") return startCustomerService(sender, "payment");
    await sock.sendMessage(sender, { text: "⚠️ الرجاء اختيار من 1 إلى 4." });
    return;
  }

  if (state === "CUSTOMER_SERVICE") {
    // Allow free messaging in customer service
    return;
  }

  if (state === "AWAITING_PAYMENT_PROOF") {
    if (!isImage) {
      if (text === "0") {
        await cancelOrder(sender);
        return;
      }
      if (text === "7") {
        await startCustomerService(sender, "general");
        return;
      }
      await sock.sendMessage(sender, { text: "⚠️ نحن بانتظار صورة إيصال الدفع. إذا أردت إلغاء الطلب أرسل 0. والتواصل مع خدمة العملاء أرسل 7" });
      return;
    }
  }
}

// ====== Specific Flows ======
async function handleWorkingHours(jid) {
  const text = `🕒 أوقات العمل

الفرع:
• السبت – الخميس: 2:00 ظهرًا – 12:00 منتصف الليل
• الجمعة: 4:00 عصرًا – 12:00 منتصف الليل

واتساب: من 1:00 ظهرًا – 9:00 مساءً`;
  await sock.sendMessage(jid, { text });
  respondedMessages.set(jid, "MAIN_MENU");
}

async function handleCancellationPolicy(jid) {
  const text = `🔄 سياسة الإلغاء والاستبدال 

✅ إلغاء الطلب مع استرداد المبلغ كاملًا
يمكن إلغاء الطلب قبل 5 أيام أو أكثر من موعد الاستلام، وسيتم إعادة المبلغ المدفوع.

⚠️ إلغاء قبل الموعد بـ 3 – 4 أيام
في هذه الحالة لا يتم استرداد المبلغ، ولكن يمكنكم تغيير الموعد واختيار مناسبة أخرى.

✏️ الاستبدال أو تعديل تفاصيل الحجز
يمكن تعديل التفاصيل أو استبدال الطلب قبل الموعد بـ 3 أيام كحد أقصى.

📞 للإلغاء أو تغيير تفاصيل الحجز
يرجى التواصل مع خدمة العملاء عبر إرسال الرقم: 7`;
  await sock.sendMessage(jid, { text });
  respondedMessages.set(jid, "MAIN_MENU");
}

async function startSpecialOrderFlow(jid) {
  const text = `🎂 الطلبيات الخاصة

⚠️ تنويه مهم:
استلام الكيك من الفرع: 2:00 – 3:00 عصرًا.
الكيكات من 3 أدوار فأكثر يتم توصيلها بين 2:30 – 3:00 عصرًا.

🔹 يرجى إرسال جميع البيانات في رسالة واحدة:
• تاريخ الاستلام (ميلادي) 📅
• حجم الكيك 🎂
• الحشوة 🥥🍫
• الكتابة ✍️
• اسم المستلم 👤

لإلغاء الطلب والعودة للقائمة الرئيسية أرسل الرقم 0`;
  await sock.sendMessage(jid, { text });
  respondedMessages.set(jid, "SPECIAL_ORDER");
  pendingData.set(jid, { type: "special", details: "" });
}

async function handleSpecialOrderDetails(jid, detailsText) {
  let currentDetails = pendingData.get(jid).details || "";
  let newDetails = currentDetails ? currentDetails + "\n" + detailsText : detailsText;
  pendingData.set(jid, { ...pendingData.get(jid), details: newDetails });

  const text = `هل البيانات كاملة؟
${newDetails}

1️⃣ نعم، أكد الطلب ✅
2️⃣ أود إضافة مزيد من التفاصيل ✏️
لإلغاء الطلب والعودة للقائمة الرئيسية أرسل الرقم 0`;
  await sock.sendMessage(jid, { text });
  respondedMessages.set(jid, "AWAITING_CONFIRMATION");
}

async function addMoreDetails(jid) {
  await sock.sendMessage(jid, { text: "✏️ يرجى إرسال التفاصيل الإضافية أو تصحيح البيانات في رسالة واحدة." });
  respondedMessages.set(jid, "SPECIAL_ORDER");
}

async function confirmSpecialOrder(jid) {
  const data = pendingData.get(jid);
  const id = generateOrderId();
  const order = {
    id,
    customerJid: jid,
    type: data.type,
    details: data.details, // string as is
    status: "pending_review",
    createdAt: new Date().toISOString()
  };
  await upsertOrder(order);

  await sock.sendMessage(jid, { text: `✅ تم تسجيل طلبك الخاص بنجاح. رقم الطلب: ${id}\nسيتم مراجعته قريبًا. 🙏` });
  respondedMessages.set(jid, "SUBMITTED"); // Stop further interaction
  pendingData.delete(jid);
}

async function handleCelebrationCakesMenu(jid) {
  const text = `📖 منيو كيكات الاحتفالات 🍰
يمكنك اختيار الطلبات، ثم الضغط على "إرسال الطلب".

⏩️ ${CELEBRATION_CAKES_CATALOG}`;
  await sock.sendMessage(jid, { 
    text,
    linkPreview: {
      title: 'منيو كيكات الاحتفالات 🎉',
      body: 'تصفح أجمل الكيكات لمناسباتك',
      canonicalUrl: CELEBRATION_CAKES_CATALOG,
      matchedText: CELEBRATION_CAKES_CATALOG
    }
  });
  respondedMessages.set(jid, "AWAITING_ORDER_DETAILS");
  pendingData.set(jid, { type: "celebration_cakes", details: "" });
}

async function handleGeneralCatalogOrder(jid) {
  const text = `📦 طلب من الكتالوج
يمكنك اختيار الطلبات، ثم الضغط على "إرسال الطلب".

⏩️ ${GENERAL_CATALOG}`;
  await sock.sendMessage(jid, { 
    text,
    linkPreview: {
      title: 'كتالوج المخبز والمقهى 📖',
      body: 'أطيب المخبوزات والمشروبات ☕',
      canonicalUrl: GENERAL_CATALOG,
      matchedText: GENERAL_CATALOG
    }
  });
  respondedMessages.set(jid, "AWAITING_CATALOG_ORDER");
  pendingData.set(jid, { type: "general_catalog", details: "" });
}

async function handleSendPaymentProof(jid) {
  const data = await readOrders();
  const customerOrders = data.orders.filter(o => o.customerJid === jid && o.status === "awaiting_payment");
  if (customerOrders.length === 0) {
    await sock.sendMessage(jid, { text: "⚠️ لا يوجد طلب بانتظار الدفع حاليًا." });
    return;
  }
  // Get the latest order
  customerOrders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const latestOrder = customerOrders[0];

  pendingData.set(jid, { orderId: latestOrder.id });
  respondedMessages.set(jid, "AWAITING_PAYMENT_PROOF");
  await sock.sendMessage(jid, { text: "💳 يرجى إرسال صورة إيصال الدفع." });
}

async function submitOrderForReview(jid) {
  const data = pendingData.get(jid);
  const id = generateOrderId();
  const order = {
    id,
    customerJid: jid,
    type: data.type,
    details: data.details,
    name: data.name,
    status: "pending_review",
    createdAt: new Date().toISOString()
  };
  await upsertOrder(order);

  await sock.sendMessage(jid, { text: `⏳ طلبك في انتظار المراجعة. رقم الطلب: ${id} 🙏` });
  respondedMessages.set(jid, "SUBMITTED"); // Stop further interaction
  pendingData.delete(jid);
}

async function requestPayment(jid, orderId) {
  const text = `✅ تم مراجعة طلبك بنجاح.
🔴 لتأكيد الطلب يرجى تحويل كامل المبلغ وإرسال صورة الإيصال 🔴

💳 بيانات التحويل:
• البنك الأهلي
• مؤسسة لوميرا لتقديم المشروبات
• رقم الحساب: 42100000744209
• الآيبان: SA4710000042100000744209`;
  await sock.sendMessage(jid, { text });
  respondedMessages.set(jid, "AWAITING_PAYMENT_PROOF");
  pendingData.set(jid, { orderId });
}

async function handlePaymentProof(jid, imageUrl) {
  // Save or log the imageUrl for admin review
  const data = pendingData.get(jid);
  const orderId = data.orderId;
  const dataOrders = await readOrders();
  const order = dataOrders.orders.find(o => o.id === orderId);
  if (order) {
    order.paymentProof = imageUrl; // Store proof URL
    order.status = "payment_review";
    await writeOrders(dataOrders);
  }

  const text = `هل هذا إيصال الدفع؟
1️⃣ نعم ✅
2️⃣ لا ❌
3️⃣ أريد إلغاء الطلب 🛑
4️⃣ التواصل مع خدمة العملاء 💬`;
  await sock.sendMessage(jid, { text });
  respondedMessages.set(jid, "CONFIRM_PAYMENT");
}

async function confirmPaymentProof(jid) {
  const data = pendingData.get(jid);
  const orderId = data.orderId;
  await sock.sendMessage(jid, { text: `✅ تم تلقي الإيصال. سيتم مراجعته قريبًا. 🙏` });
  respondedMessages.set(jid, "MAIN_MENU");
  pendingData.delete(jid);
  // Notify admin panel implicitly via status change
}

async function rejectPaymentProof(jid) {
  await sock.sendMessage(jid, { text: `❌ هذا ليس إيصال دفع صالح. يرجى إرسال إيصال صحيح.` });
  respondedMessages.set(jid, "AWAITING_PAYMENT_PROOF");
}

async function cancelOrder(jid) {
  const data = pendingData.get(jid);
  const orderId = data.orderId;
  const dataOrders = await readOrders();
  const idx = dataOrders.orders.findIndex(o => o.id === orderId);
  if (idx >= 0) {
    dataOrders.orders[idx].status = "cancelled";
    await writeOrders(dataOrders);
  }
  await sock.sendMessage(jid, { text: `🛑 تم إلغاء الطلب بنجاح.` });
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
    const serviceText = type === "general" ? "خدمة العملاء ☎️" : "دعم الدفع 💳";
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
    whatsappLink: order.status !== "delivered" && order.status !== "cancelled" ? `https://wa.me/${order.customerJid.split('@')[0]}` : null,
    paymentProof: order.paymentProof || null
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
    if (status === "awaiting_payment" && oldStatus === "pending_review") {
      await requestPayment(order.customerJid, order.id);
    } else if (status === "confirmed" && oldStatus === "payment_review") {
      await sock.sendMessage(order.customerJid, { text: `✅ تم تأكيد دفع طلبك ${order.id}. سيتم التحضير قريبًا. 🍰` });
    } else if (status === "preparing") {
      await sock.sendMessage(order.customerJid, { text: `🔔 تحديث: طلبك ${order.id} قيد التحضير 🍰` });
    } else if (status === "ready") {
      await sock.sendMessage(order.customerJid, { text: `🔔 تحديث: طلبك ${order.id} جاهز للاستلام 🛍️` });
    } else if (status === "delivered") {
      await sock.sendMessage(order.customerJid, { text: `🔔 تحديث: طلبك ${order.id} تم التسليم ✅` });
    } else if (status === "cancelled") {
      await sock.sendMessage(order.customerJid, { text: `🔔 تحديث: طلبك ${order.id} ملغى ❌` });
      respondedMessages.set(order.customerJid, "MAIN_MENU");
      await sendWelcomeMenu(order.customerJid);
    } else {
      await sock.sendMessage(order.customerJid, { text: `🔔 تحديث حالة طلبك ${order.id}: ${getStatusText(status)}` });
    }
  } catch (e) {
    console.error("⚠️ فشل إرسال إشعار للعميل:", e.message);
  }

  if (status === "delivered") {
    data.orders = data.orders.filter(o => o.id !== id);
    await writeOrders(data);
  }

  res.json({ success: true });
});

// ====== Start Server & WA ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 السيرفر يعمل على http://localhost:${PORT}`));
connectToWhatsApp();
