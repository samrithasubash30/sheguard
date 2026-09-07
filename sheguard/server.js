const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const twilio = require('twilio');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ─── Serve static files from /public ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Email Transporter (Gmail + App Password) ────────────────────────────────
const mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
    },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 8000,
});

// ─── SMS Client (Twilio) ───────────────────────────────────────────────────────
const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

// ─── PostgreSQL Connection ────────────────────────────────────────────────────
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

// ─── Initialize Database Schema ──────────────────────────────────────────────
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS profiles (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                name TEXT,
                dob TEXT,
                address TEXT,
                city TEXT,
                state TEXT,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        // Migrate any pre-existing profiles table (created before this change)
        await client.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS name TEXT`);
        await client.query(`ALTER TABLE profiles DROP COLUMN IF EXISTS gender`);
        await client.query(`ALTER TABLE profiles DROP COLUMN IF EXISTS blood_type`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS contacts (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                relationship TEXT,
                phone TEXT NOT NULL,
                backup_phone TEXT,
                email TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        // Migrate any pre-existing contacts table (created before this change)
        await client.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email TEXT`);
        console.log('PostgreSQL database schemas initialized successfully.');
    } catch (err) {
        console.error('Database initialization error:', err);
    } finally {
        client.release();
    }
}

initializeDatabase();

// ─── API ENDPOINTS ────────────────────────────────────────────────────────────

// 1. REGISTER
app.post('/api/auth/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required.' });
    if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id',
            [email.toLowerCase().trim(), hashedPassword]
        );
        res.json({ success: true, userId: result.rows[0].id, message: 'Account created successfully.' });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
        console.error('Register error:', err);
        res.status(500).json({ success: false, message: 'Server error during registration.' });
    }
});

// 2. LOGIN
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required.' });
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
        if (result.rows.length === 0) return res.status(401).json({ success: false, message: 'Invalid email or password.' });
        const user = result.rows[0];
        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) return res.status(401).json({ success: false, message: 'Invalid email or password.' });
        res.json({ success: true, userId: user.id, email: user.email, message: 'Authentication clearance verified.' });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, message: 'Server error during login.' });
    }
});

// 3. SAVE PROFILE
app.post('/api/profile/save', async (req, res) => {
    const { userId, name, dob, address, city, state } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'User ID is required.' });
    try {
        await pool.query(`
            INSERT INTO profiles (user_id, name, dob, address, city, state, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, NOW())
ON CONFLICT (user_id) DO UPDATE SET
    name = EXCLUDED.name, dob = EXCLUDED.dob,
    address = EXCLUDED.address, city = EXCLUDED.city,
    state = EXCLUDED.state, updated_at = NOW()
`, [userId, name, dob, address, city, state]);
        res.json({ success: true, message: 'Personal metrics synchronized successfully.' });
    } catch (err) {
        console.error('Profile save error:', err);
        res.status(500).json({ success: false, message: 'Failed to save profile data.' });
    }
});

// 4. GET PROFILE
app.get('/api/profile/:userId', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM profiles WHERE user_id = $1', [req.params.userId]);
        if (result.rows.length === 0) return res.json({ success: true, profile: null });
        res.json({ success: true, profile: result.rows[0] });
    } catch (err) {
        console.error('Profile fetch error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch profile.' });
    }
});

// 5. SAVE CONTACTS
app.post('/api/contacts/save', async (req, res) => {
    const { userId, contactsList } = req.body;
    if (!userId || !contactsList || !Array.isArray(contactsList)) return res.status(400).json({ success: false, message: 'Invalid contacts data.' });
    const validContacts = contactsList.filter(c => c.name && c.phone);
    if (validContacts.length === 0) return res.status(400).json({ success: false, message: 'At least one contact with name and phone is required.' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM contacts WHERE user_id = $1', [userId]);
        for (const c of validContacts) {
            await client.query(
                'INSERT INTO contacts (user_id, name, relationship, phone, backup_phone, email) VALUES ($1, $2, $3, $4, $5, $6)',
                [userId, c.name, c.relationship || '', c.phone, c.backup_phone || '', c.email || '']
            );
        }
        await client.query('COMMIT');
        res.json({ success: true, message: `${validContacts.length} contacts saved successfully.` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Contacts save error:', err);
        res.status(500).json({ success: false, message: 'Failed to save contacts.' });
    } finally {
        client.release();
    }
});

// 6. GET CONTACTS FOR DASHBOARD
app.get('/api/dashboard/data/:userId', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT name, relationship, phone, backup_phone, email FROM contacts WHERE user_id = $1 ORDER BY id ASC',
            [req.params.userId]
        );
        res.json({ success: true, contacts: result.rows });
    } catch (err) {
        console.error('Dashboard data fetch error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch dashboard data.' });
    }
});

// 7. GET USER
app.get('/api/user/:userId', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, email FROM users WHERE id = $1', [req.params.userId]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found.' });
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        console.error('User fetch error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch user.' });
    }
});

// 8. SEND EMERGENCY EMAIL ALERT
app.post('/api/emergency/notify', async (req, res) => {
    const { userId, cause, mapUrl } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'User ID is required.' });

    try {
        const profileResult = await pool.query('SELECT name FROM profiles WHERE user_id = $1', [userId]);
        const userName = (profileResult.rows[0] && profileResult.rows[0].name) || 'A SafeHer user';

        const contactsResult = await pool.query(
            'SELECT name, relationship, phone, email FROM contacts WHERE user_id = $1 ORDER BY id ASC',
            [userId]
        );

        const locationLine = mapUrl ? `\n\nTheir live location: ${mapUrl}` : '';
        const reasonLine = cause ? `\n\nReason: ${cause}` : '';

        // ── EMAIL (Gmail/Nodemailer) ──────────────────────────────────────────
        const emailContacts = contactsResult.rows.filter(c => c.email && c.email.trim() !== '');
        const subject = `🚨 SafeHer Emergency Alert from ${userName}`;
        let emailSentCount = 0;
        let emailLastError = null;
        for (const contact of emailContacts) {
            const bodyText = `Hi ${contact.name},\n\n${userName} has triggered a SafeHer emergency alert and may need help.${reasonLine}${locationLine}\n\nPlease reach out to them or contact local authorities if you're unable to reach them.\n\n— Sent automatically by SafeHer`;
            try {
                await mailTransporter.sendMail({
                    from: `"SafeHer Alerts" <${process.env.GMAIL_USER}>`,
                    to: contact.email,
                    subject: subject,
                    text: bodyText,
                });
                emailSentCount++;
            } catch (mailErr) {
                console.error(`Failed to email ${contact.email}:`, mailErr.message);
                emailLastError = mailErr.message;
            }
        }

        // ── SMS (Twilio) ──────────────────────────────────────────────────────
        const phoneContacts = contactsResult.rows.filter(c => c.phone && c.phone.trim() !== '');
        let smsSentCount = 0;
        let smsLastError = null;

        if (!twilioClient) {
            smsLastError = 'Twilio is not configured on the server.';
        } else if (!process.env.TWILIO_PHONE_NUMBER) {
            smsLastError = 'TWILIO_PHONE_NUMBER is not set on the server.';
        } else {
            for (const contact of phoneContacts) {
                const smsText = `SafeHer Alert: ${userName} may need help.${reasonLine}${locationLine}`;
                try {
                    await twilioClient.messages.create({
                        body: smsText,
                        from: process.env.TWILIO_PHONE_NUMBER,
                        to: contact.phone,
                    });
                    smsSentCount++;
                } catch (smsErr) {
                    console.error(`Failed to SMS ${contact.phone}:`, smsErr.message);
                    smsLastError = smsErr.message;
                }
            }
        }

        // ── VOICE CALL (Twilio) — real call to the top-priority contact only ───
        let callStatus = null;
        const topContact = phoneContacts[0];

        if (topContact) {
            if (!twilioClient) {
                callStatus = { placed: false, to: topContact.name, error: 'Twilio is not configured on the server.' };
            } else if (!process.env.TWILIO_PHONE_NUMBER) {
                callStatus = { placed: false, to: topContact.name, error: 'TWILIO_PHONE_NUMBER is not set on the server.' };
            } else {
                try {
                    const baseUrl = process.env.APP_BASE_URL || `https://${req.get('host')}`;
                    const twimlUrl = `${baseUrl}/api/twiml/emergency-call?name=${encodeURIComponent(userName)}${cause ? `&cause=${encodeURIComponent(cause)}` : ''}`;
                    await twilioClient.calls.create({
                        url: twimlUrl,
                        method: 'GET',
                        from: process.env.TWILIO_PHONE_NUMBER,
                        to: topContact.phone,
                    });
                    callStatus = { placed: true, to: topContact.name };
                } catch (callErr) {
                    console.error(`Failed to call ${topContact.phone}:`, callErr.message);
                    callStatus = { placed: false, to: topContact.name, error: callErr.message };
                }
            }
        }

        res.json({
            success: true,
            email: { sent: emailSentCount, total: emailContacts.length, error: emailSentCount === 0 ? emailLastError : null },
            sms: { sent: smsSentCount, total: phoneContacts.length, error: smsSentCount === 0 ? smsLastError : null },
            call: callStatus,
        });
    } catch (err) {
        console.error('Emergency notify error:', err);
        res.status(500).json({ success: false, message: 'Failed to send emergency alerts.' });
    }
});

// 9. TWIML FOR EMERGENCY VOICE CALL — tells Twilio what to say when the call connects
function escapeXml(text) {
    return String(text).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

app.get('/api/twiml/emergency-call', (req, res) => {
    const name = escapeXml(req.query.name || 'a SafeHer user');
    const causeText = req.query.cause ? escapeXml(req.query.cause) : null;

    let situationLine;
    if (causeText) {
        situationLine = `This alert was triggered because: ${causeText}.`;
    } else {
        situationLine = `This alert was triggered from their SafeHer app.`;
    }

    const message = `Hello. This is an automated safety call from SafeHer. ${name} has triggered an emergency alert and may need urgent help. ${situationLine} Please try calling ${name} right away, or check the SafeHer app for their live location. If you cannot reach them, please consider contacting local authorities. This message will now repeat.`;

    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>${message}</Say>
    <Pause length="1"/>
    <Say>${message}</Say>
</Response>`);
});

// ─── PAGE ROUTES ──────────────────────────────────────────────────────────────
// Splash screen is the entry point
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'splash.html'));
});

app.get('/home', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/splash', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'splash.html'));
});

// Fallback - serve index for any unknown route
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`SheGuard Full-Stack Server executing at http://localhost:${PORT}`);
});