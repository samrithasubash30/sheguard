const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware configuration layer
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── PostgreSQL Connection (Railway auto-injects DATABASE_URL) ───────────────
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ─── Initialize Database Schema ──────────────────────────────────────────────
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        // 1. Users table
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // 2. Profiles table
        await client.query(`
            CREATE TABLE IF NOT EXISTS profiles (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                dob TEXT,
                gender TEXT,
                blood_type TEXT,
                address TEXT,
                city TEXT,
                state TEXT,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // 3. Contacts table
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

        console.log('PostgreSQL database schemas initialized successfully.');
    } catch (err) {
        console.error('Database initialization error:', err);
    } finally {
        client.release();
    }
}

initializeDatabase();

// ─── API ENDPOINTS ────────────────────────────────────────────────────────────

// 1. REGISTER NEW USER
app.post('/api/auth/register', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    if (password.length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id',
            [email.toLowerCase().trim(), hashedPassword]
        );
        res.json({ success: true, userId: result.rows[0].id, message: 'Account created successfully.' });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
        }
        console.error('Register error:', err);
        res.status(500).json({ success: false, message: 'Server error during registration.' });
    }
});

// 2. LOGIN AUTHENTICATION
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1',
            [email.toLowerCase().trim()]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid email or password.' });
        }

        const user = result.rows[0];
        const passwordMatch = await bcrypt.compare(password, user.password);

        if (!passwordMatch) {
            return res.status(401).json({ success: false, message: 'Invalid email or password.' });
        }

        res.json({ success: true, userId: user.id, email: user.email, message: 'Authentication clearance verified.' });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, message: 'Server error during login.' });
    }
});

// 3. SAVE PERSONAL PROFILE METRICS
app.post('/api/profile/save', async (req, res) => {
    const { userId, dob, gender, bloodType, address, city, state } = req.body;

    if (!userId) {
        return res.status(400).json({ success: false, message: 'User ID is required.' });
    }

    try {
        await pool.query(`
            INSERT INTO profiles (user_id, dob, gender, blood_type, address, city, state, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            ON CONFLICT (user_id) DO UPDATE SET
                dob = EXCLUDED.dob,
                gender = EXCLUDED.gender,
                blood_type = EXCLUDED.blood_type,
                address = EXCLUDED.address,
                city = EXCLUDED.city,
                state = EXCLUDED.state,
                updated_at = NOW()
        `, [userId, dob, gender, bloodType, address, city, state]);

        res.json({ success: true, message: 'Personal metrics synchronized successfully.' });
    } catch (err) {
        console.error('Profile save error:', err);
        res.status(500).json({ success: false, message: 'Failed to save profile data.' });
    }
});

// 4. GET PROFILE (to pre-fill form on revisit)
app.get('/api/profile/:userId', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM profiles WHERE user_id = $1',
            [req.params.userId]
        );
        if (result.rows.length === 0) {
            return res.json({ success: true, profile: null });
        }
        res.json({ success: true, profile: result.rows[0] });
    } catch (err) {
        console.error('Profile fetch error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch profile.' });
    }
});

// 5. SAVE TRUSTED CIRCLE CONTACTS
app.post('/api/contacts/save', async (req, res) => {
    const { userId, contactsList } = req.body;

    if (!userId || !contactsList || !Array.isArray(contactsList)) {
        return res.status(400).json({ success: false, message: 'Invalid contacts data.' });
    }

    // Filter out empty entries
    const validContacts = contactsList.filter(c => c.name && c.phone);

    if (validContacts.length === 0) {
        return res.status(400).json({ success: false, message: 'At least one contact with name and phone is required.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Delete old contacts for this user
        await client.query('DELETE FROM contacts WHERE user_id = $1', [userId]);

        // Insert all new contacts
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

// 7. GET USER EMAIL (for display)
app.get('/api/user/:userId', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, email FROM users WHERE id = $1',
            [req.params.userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        console.error('User fetch error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch user.' });
    }
});

// Serve splash as home, all other routes serve their own files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'splash.html'));
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`SheGuard Full-Stack Server executing at http://localhost:${PORT}`);
});
