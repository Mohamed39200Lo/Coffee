const makeWASocket = require("@whiskeysockets/baileys").default;
const { useMultiFileAuthState } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode");
const express = require("express");
const path = require("path");
const fs = require("fs").promises;
const app = express();

// 🔹 الجروب المستهدف لتحويل الرسائل
const TARGET_GROUP = "120363403583957683@g.us"; // معرف الجروب من الرابط: https://chat.whatsapp.com/LtHfE2bNiw80dMPzOMpAyi
global.qrCodeUrl = null;

// 🔹 دالة لتسجيل اللوغ
async function logToFile(message) {
    await fs.appendFile("bot.log", `${new Date().toISOString()} - ${message}\n`);
}

// 🔹 دالة الاتصال بواتساب
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth");
    const sock = makeWASocket({ auth: state, printQRInTerminal: false });

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", handleConnectionUpdate);

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        // 🔹 تحديد ما إذا كانت الرسالة من جروب
        const isGroupMessage = msg.key.remoteJid.endsWith("@g.us");
        let sender = isGroupMessage ? msg.key.participant : msg.key.remoteJid;

        // 🔹 التحقق من LID ومحاولة استخراج رقم الهاتف
        let senderNumber;
        if (isGroupMessage && sender && sender.endsWith("@lid")) {
            // محاولة جلب رقم الهاتف من معلومات الاتصال
            try {
                const contact = await sock.getContactInfo(sender);
                const phoneNumber = contact?.verifiedNumber || contact?.number || null;
                senderNumber = phoneNumber ? phoneNumber.split("@")[0] : null;
                if (!senderNumber) {
                    await logToFile(`❌ معرف LID (${sender}) بدون رقم هاتف متاح! الرسالة لن يتم توجيهها.`);
                    console.error(`❌ معرف LID (${sender}) بدون رقم هاتف متاح! الرسالة لن يتم توجيهها.`);
                    return;
                }
            } catch (error) {
                await logToFile(`❌ فشل جلب معلومات الاتصال لـ ${sender}: ${error.message}`);
                console.error(`❌ فشل جلب معلومات الاتصال لـ ${sender}: ${error.message}`);
                return;
            }
        } else if (sender) {
            senderNumber = sender.split("@")[0];
        } else {
            await logToFile("❌ لا يمكن تحديد المرسل لهذه الرسالة!");
            console.error("❌ لا يمكن تحديد المرسل لهذه الرسالة!");
            return;
        }

        // 🔹 تسجيل معلومات للتصحيح
        await logToFile(`Message received: remoteJid=${msg.key.remoteJid}, participant=${msg.key.participant}, isGroup=${isGroupMessage}, sender=${sender}, senderNumber=${senderNumber}`);
        console.log(`Message received: remoteJid=${msg.key.remoteJid}, participant=${msg.key.participant}, isGroup=${isGroupMessage}, sender=${sender}, senderNumber=${senderNumber}`);

        let text;
        try {
            text = (
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption ||
                ""
            ).trim();
        } catch (error) {
            await logToFile(`❌ فشل فك تشفير الرسالة من ${sender}: ${error.message}`);
            console.error(`❌ فشل فك تشفير الرسالة من ${sender}: ${error.message}`);
            return; // تخطي الرسائل التي لا يمكن فك تشفيرها
        }

        // 🔹 التحقق من وجود الكلمات المفتاحية وعدم وجود أي رابط لوكيشن
        const keywords = ["الزبون", "المشتري", "المشترى", "مطلوب"];
        const containsKeyword = keywords.some(keyword => text.includes(keyword));
        const containsLocationLink = /https?:\/\/.*(maps|location|goo\.gl\/maps|maps\.app\.goo\.gl|maps\.google\.com|maps\.apple\.com)/i.test(text);

        if (containsKeyword && !containsLocationLink) {
            // 🔹 إعادة توجيه الرسالة إلى الجروب مع رابط محادثة المرسل
            const forwardedMessage = `رسالة من: https://wa.me/${senderNumber}\n\n${text}`;
            await logToFile(`Forwarding message from ${senderNumber}: ${text}`);
            console.log(`Forwarding message from ${senderNumber}: ${text}`);
            await sock.sendMessage(TARGET_GROUP, { text: forwardedMessage });
        } else {
            await logToFile(`Message not forwarded from ${senderNumber}. Keywords: ${containsKeyword}, Location Link: ${containsLocationLink}`);
            console.log(`Message not forwarded from ${senderNumber}. Keywords: ${containsKeyword}, Location Link: ${containsLocationLink}`);
        }
    });
}

// 🔹 معالجة حالة الاتصال
function handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
        console.log("✅ تم توليد رمز QR! امسحه للاتصال.");
        qrcode.toDataURL(qr, (err, url) => {
            if (err) console.error("❌ خطأ في إنشاء QR:", err);
            global.qrCodeUrl = url;
        });
    }

    if (connection === "close") {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
        console.log("🚨 تم فصل الاتصال، جارٍ إعادة الاتصال...", shouldReconnect);
        if (shouldReconnect) setTimeout(connectToWhatsApp, 3000);
    } else if (connection === "open") {
        console.log("✅ تم الاتصال بنجاح!");
        global.qrCodeUrl = null; // مسح رمز QR بعد الاتصال الناجح
    }
}

// 🔹 إعدادات السيرفر
app.use(express.json());
app.use("/panel", express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.send(global.qrCodeUrl
        ? `<h1>امسح رمز QR للاتصال بالبوت</h1><img src="${global.qrCodeUrl}" width="300">`
        : "<h1>لم يتم توليد رمز QR بعد... يرجى الانتظار!</h1>");
});

app.listen(3000, () => console.log("🚀 السيرفر يعمل على http://localhost:3000"));
connectToWhatsApp();
