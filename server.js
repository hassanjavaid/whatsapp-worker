const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const mysql = require('mysql2/promise');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// Database configuration
const dbConfig = {
    host: process.env.MYSQLHOST || '159.69.141.61',
    port: process.env.MYSQLPORT || 3306,
    user: process.env.MYSQLUSER || 'labsoftw_whatsapp',
    password: process.env.MYSQLPASSWORD || 'labsoftw_whatsapp',
    database: process.env.MYSQLDATABASE || 'labsoftw_whatsapp'
};

let db;
const sessions = new Map();

async function initDB() {
    try {
        console.log('🔌 Connecting to database...');
        console.log(`   Host: ${dbConfig.host}`);
        console.log(`   Port: ${dbConfig.port}`);
        console.log(`   User: ${dbConfig.user}`);
        console.log(`   Database: ${dbConfig.database}`);
        
        db = await mysql.createConnection(dbConfig);
        console.log('✅ Database connected');
        
        await db.query('SELECT 1');
        console.log('✅ Database query successful');
        
    } catch (err) {
        console.error('❌ Database connection failed:', err.message);
    }
}

// Start WhatsApp session
app.post('/start-session', async (req, res) => {
    const { instance_id, session_path } = req.body;
    
    console.log(`\n📱 ========== START SESSION ==========`);
    console.log(`Instance ID: ${instance_id}`);
    console.log(`Session path: ${session_path}`);
    
    try {
        const sessionDir = path.join(__dirname, session_path);
        if (!fs.existsSync(sessionDir)) {
            console.log(`📁 Creating session directory: ${sessionDir}`);
            fs.mkdirSync(sessionDir, { recursive: true });
        }
        
        console.log(`🤖 Creating WhatsApp client...`);
        
        // NO executablePath specified - let Puppeteer find Chromium
        const client = new Client({
            authStrategy: new LocalAuth({ dataPath: sessionDir }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-software-rasterizer'
                ]
            }
        });
        
        sessions.set(instance_id, { client });
        
        client.on('qr', async (qr) => {
            console.log(`🎯 QR CODE RECEIVED for ${instance_id}`);
            const qrDataURL = await qrcode.toDataURL(qr);
            await db.execute(
                "UPDATE instances SET qr_code = ?, status = 'scanning', qr_code_expires = DATE_ADD(NOW(), INTERVAL 2 MINUTE) WHERE instance_id = ?",
                [qrDataURL, instance_id]
            );
            console.log(`✅ QR saved to database for ${instance_id}`);
        });
        
        client.on('authenticated', () => {
            console.log(`🔐 ${instance_id} authenticated successfully!`);
        });
        
        client.on('ready', async () => {
            console.log(`🎉 ${instance_id} IS READY!`);
            const info = client.info;
            const phoneNumber = info.wid.user;
            console.log(`   Phone number: ${phoneNumber}`);
            await db.execute(
                "UPDATE instances SET status = 'connected', phone_number = ?, last_active = NOW() WHERE instance_id = ?",
                [phoneNumber, instance_id]
            );
        });
        
        client.on('message', async (message) => {
            console.log(`📨 Message from ${message.from} to ${instance_id}`);
            const [rows] = await db.execute("SELECT id FROM instances WHERE instance_id = ?", [instance_id]);
            if (rows.length > 0) {
                await db.execute(
                    "INSERT INTO incoming_messages (instance_id, from_number, message_type, content) VALUES (?, ?, ?, ?)",
                    [rows[0].id, message.from, message.type, message.body]
                );
            }
        });
        
        client.on('auth_failure', async (msg) => {
            console.error(`❌ Auth failed for ${instance_id}: ${msg}`);
            await db.execute("UPDATE instances SET status = 'expired' WHERE instance_id = ?", [instance_id]);
        });
        
        client.on('disconnected', async (reason) => {
            console.log(`🔌 ${instance_id} disconnected: ${reason}`);
            await db.execute("UPDATE instances SET status = 'disconnected' WHERE instance_id = ?", [instance_id]);
            sessions.delete(instance_id);
        });
        
        console.log(`🚀 Initializing WhatsApp client...`);
        await client.initialize();
        console.log(`✅ Client initialized for ${instance_id}`);
        res.json({ success: true });
        
    } catch (error) {
        console.error(`❌ Error starting session:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

// Send message
app.post('/send-message', async (req, res) => {
    const { instance_id, recipient, message, message_id } = req.body;
    
    try {
        const session = sessions.get(instance_id);
        if (!session || !session.client) {
            return res.status(400).json({ error: 'Session not connected' });
        }
        
        const client = session.client;
        let number = recipient;
        if (!number.includes('@')) number = `${number}@c.us`;
        
        const result = await client.sendMessage(number, message);
        if (db) await db.execute("UPDATE messages SET status = 'sent', message_id = ?, sent_at = NOW() WHERE id = ?", [result.id.id, message_id]);
        res.json({ success: true });
        
    } catch (error) {
        console.error('Send error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        sessions: sessions.size,
        db: db ? 'connected' : 'disconnected'
    });
});

// Start server
async function start() {
    await initDB();
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        console.log(`\n🚀 WhatsApp Worker running on port ${port}`);
        console.log(`📊 Health: /health`);
        console.log(`💾 Database: ${db ? 'Connected' : 'Disconnected'}\n`);
    });
}

start();