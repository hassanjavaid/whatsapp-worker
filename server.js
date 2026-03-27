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

// HARDCODED YOUR CPANEL DB DETAILS - NO ENV VARIABLES
const dbConfig = {
    host: '159.69.141.61',
    port: 3306,
    user: 'labsoftw_whatsapp',
    password: 'labsoftw_whatsapp',
    database: 'labsoftw_whatsapp'
};

let db;
const sessions = new Map();

async function initDB() {
    try {
        console.log('Connecting to cPanel DB...');
        db = await mysql.createConnection(dbConfig);
        console.log('✅ Database connected');
        await db.query('SELECT 1');
        console.log('✅ Query successful');
    } catch (err) {
        console.error('❌ DB Error:', err.message);
        console.error('Make sure Railway IP is added to cPanel Remote MySQL');
    }
}

app.post('/start-session', async (req, res) => {
    const { instance_id, session_path } = req.body;
    
    try {
        const sessionDir = path.join(__dirname, session_path);
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
        
        console.log(`Starting: ${instance_id}`);
        
        const client = new Client({
            authStrategy: new LocalAuth({ dataPath: sessionDir }),
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            }
        });
        
        sessions.set(instance_id, { client });
        
        client.on('qr', async (qr) => {
            console.log(`📱 QR for ${instance_id}`);
            const qrDataURL = await qrcode.toDataURL(qr);
            await db.execute(
                "UPDATE instances SET qr_code = ?, status = 'scanning' WHERE instance_id = ?",
                [qrDataURL, instance_id]
            );
            console.log(`✅ QR saved`);
        });
        
        client.on('ready', async () => {
            console.log(`✅ ${instance_id} READY!`);
            await db.execute(
                "UPDATE instances SET status = 'connected', phone_number = ? WHERE instance_id = ?",
                [client.info.wid.user, instance_id]
            );
        });
        
        client.on('auth_failure', (msg) => {
            console.log(`❌ Auth failed: ${msg}`);
        });
        
        await client.initialize();
        res.json({ success: true });
        
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/send-message', async (req, res) => {
    const { instance_id, recipient, message } = req.body;
    const session = sessions.get(instance_id);
    if (!session?.client) return res.status(400).json({ error: 'Not connected' });
    
    try {
        let number = recipient;
        if (!number.includes('@')) number = `${number}@c.us`;
        await session.client.sendMessage(number, message);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        sessions: sessions.size,
        db: db ? 'connected' : 'disconnected'
    });
});

async function start() {
    await initDB();
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        console.log(`🚀 Worker on port ${port}`);
        console.log(`📊 Health: /health`);
    });
}

start();