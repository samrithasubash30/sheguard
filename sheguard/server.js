const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const twilio = require('twilio');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ─── Serve static files from /public ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

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
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS alerts (
                token TEXT PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                lat DOUBLE PRECISION,
                lon DOUBLE PRECISION,
                accuracy DOUBLE PRECISION,
                ended BOOLEAN DEFAULT FALSE,
                started_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                expires_at TIMESTAMP NOT NULL
            )
        `);
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
                'INSERT INTO contacts (user_id, name, relationship, phone, backup_phone) VALUES ($1, $2, $3, $4, $5)',
                [userId, c.name, c.relationship || '', c.phone, c.backup_phone || '']
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
            'SELECT name, relationship, phone, backup_phone FROM contacts WHERE user_id = $1 ORDER BY id ASC',
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

// 8. SEND EMERGENCY ALERTS (SMS + real voice call)
app.post('/api/emergency/notify', async (req, res) => {
    const { userId, cause, lat, lon } = req.body;
    let { mapUrl } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'User ID is required.' });

    try {
        // Create a live-tracking session with a secret, unguessable token (expires in 2 hours)
        let trackToken = null;
        const latNum = parseFloat(lat), lonNum = parseFloat(lon);
        if (!isNaN(latNum) && !isNaN(lonNum)) {
            trackToken = crypto.randomBytes(16).toString('hex');
            await pool.query(
                `INSERT INTO alerts (token, user_id, lat, lon, expires_at)
                 VALUES ($1, $2, $3, $4, NOW() + INTERVAL '2 hours')`,
                [trackToken, userId, latNum, lonNum]
            );
            const base = process.env.APP_BASE_URL || `https://${req.get('host')}`;
            mapUrl = `${base.replace(/\/$/, '')}/track/${trackToken}`;
        }

        const profileResult = await pool.query('SELECT name FROM profiles WHERE user_id = $1', [userId]);
        const userName = (profileResult.rows[0] && profileResult.rows[0].name) || 'A SafeHer user';

        const contactsResult = await pool.query(
            'SELECT name, relationship, phone FROM contacts WHERE user_id = $1 ORDER BY id ASC',
            [userId]
        );

        // ── Build the SMS text so it fits in ONE 160-character segment ──────────
        // Fast2SMS bills per segment (Rs 5 each). Anything over 160 characters is
        // split into 2 SMS and billed twice, so the reason is NOT included here
        // (it is still spoken on the voice call and shown on the dashboard).
        // Keep this text plain ASCII: emojis / non-English letters cut the limit to 70.
        const SMS_LIMIT = 160;
        const shortName = String(userName).trim().slice(0, 25);
        let smsText = mapUrl
            ? `SafeHer Alert: ${shortName} may need help. Track live: ${mapUrl}`
            : `SafeHer Alert: ${shortName} may need help. Please call them now.`;
        if (smsText.length > SMS_LIMIT) {
            // Very long tracking link or name: fall back to the most compact form
            smsText = mapUrl
                ? `SafeHer: ${shortName} needs help. ${mapUrl}`
                : `SafeHer: ${shortName} needs help. Call now.`;
        }
        if (smsText.length > SMS_LIMIT) {
            smsText = smsText.slice(0, SMS_LIMIT);
        }

        // ── SMS (Fast2SMS — Quick SMS route, no DLT registration needed) ───────
        const phoneContacts = contactsResult.rows.filter(c => c.phone && c.phone.trim() !== '');
        let smsSentCount = 0;
        let smsLastError = null;

        if (!process.env.FAST2SMS_API_KEY) {
            smsLastError = 'FAST2SMS_API_KEY is not set on the server.';
        } else {
            for (const contact of phoneContacts) {
                // Fast2SMS Quick SMS route expects plain 10-digit Indian numbers (no +91 prefix)
                const plainNumber = contact.phone.replace(/[^0-9]/g, '').slice(-10);
                try {
                    const response = await fetch('https://www.fast2sms.com/dev/bulkV2', {
                        method: 'POST',
                        headers: {
                            'Authorization': process.env.FAST2SMS_API_KEY,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            route: 'q',
                            message: smsText,
                            numbers: plainNumber,
                        }),
                    });
                    const result = await response.json();
                    if (result.return === true) {
                        smsSentCount++;
                    } else {
                        console.error(`Failed to SMS ${contact.phone} via Fast2SMS:`, JSON.stringify(result));
                        if (Array.isArray(result.message)) {
                            smsLastError = result.message.join(', ');
                        } else if (typeof result.message === 'string' && result.message.trim() !== '') {
                            smsLastError = result.message;
                        } else {
                            smsLastError = 'Fast2SMS rejected the request.';
                        }
                    }
                } catch (smsErr) {
                    console.error(`Failed to SMS ${contact.phone} via Fast2SMS:`, smsErr.message);
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
            token: trackToken,
            trackUrl: mapUrl || null,
            sms: { sent: smsSentCount, total: phoneContacts.length, error: smsSentCount === 0 ? smsLastError : null },
            call: callStatus,
        });
    } catch (err) {
        console.error('Emergency notify error:', err);
        res.status(500).json({ success: false, message: 'Failed to send emergency alerts.' });
    }
});

// 8b. LIVE TRACKING — the dashboard pushes position updates (token = proof of ownership)
app.post('/api/alert/update', async (req, res) => {
    const { token, lat, lon, accuracy } = req.body;
    const latNum = parseFloat(lat), lonNum = parseFloat(lon);
    if (!token || isNaN(latNum) || isNaN(lonNum)) return res.status(400).json({ success: false });
    try {
        const r = await pool.query(
            `UPDATE alerts SET lat = $2, lon = $3, accuracy = $4, updated_at = NOW()
             WHERE token = $1 AND ended = FALSE AND expires_at > NOW()`,
            [token, latNum, lonNum, isNaN(parseFloat(accuracy)) ? null : parseFloat(accuracy)]
        );
        res.json({ success: r.rowCount > 0 });
    } catch (err) {
        console.error('Alert update error:', err);
        res.status(500).json({ success: false });
    }
});

app.post('/api/alert/end', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false });
    try {
        await pool.query('UPDATE alerts SET ended = TRUE WHERE token = $1', [token]);
        res.json({ success: true });
    } catch (err) {
        console.error('Alert end error:', err);
        res.status(500).json({ success: false });
    }
});

// 8c. LIVE TRACKING — public read by secret token (used by the contact's tracking page)
app.get('/api/track/:token', async (req, res) => {
    if (!/^[a-f0-9]{32}$/.test(req.params.token)) return res.status(404).json({ success: false });
    try {
        const r = await pool.query(
            `SELECT a.lat, a.lon, a.accuracy, a.ended, a.updated_at, a.started_at,
                    (a.expires_at < NOW()) AS expired, p.name
             FROM alerts a LEFT JOIN profiles p ON p.user_id = a.user_id
             WHERE a.token = $1`, [req.params.token]);
        if (r.rows.length === 0) return res.status(404).json({ success: false });
        const a = r.rows[0];
        res.set('Cache-Control', 'no-store');
        res.json({
            success: true,
            name: a.name || 'A SafeHer user',
            lat: a.lat, lon: a.lon, accuracy: a.accuracy,
            active: !a.ended && !a.expired,
            ended: a.ended, expired: a.expired,
            updatedAt: a.updated_at, startedAt: a.started_at,
        });
    } catch (err) {
        console.error('Track fetch error:', err);
        res.status(500).json({ success: false });
    }
});

app.get('/track/:token', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'track.html'));
});

// 9. TWIML FOR EMERGENCY VOICE CALL — tells Twilio what to say when the call connects
function escapeXml(text) {
    return String(text).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function handleEmergencyCallTwiml(req, res) {
    const params = { ...req.query, ...req.body };
    const name = escapeXml(params.name || 'a SafeHer user');
    const causeText = params.cause ? escapeXml(params.cause) : null;

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
}

app.get('/api/twiml/emergency-call', handleEmergencyCallTwiml);
app.post('/api/twiml/emergency-call', handleEmergencyCallTwiml);

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