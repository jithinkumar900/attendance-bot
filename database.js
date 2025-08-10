const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class Database {
    constructor(dbPath = './attendance.db') {
        this.db = new sqlite3.Database(dbPath);
        this.initTables();
    }

    initTables() {
        const queries = [
            `CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            
            `CREATE TABLE IF NOT EXISTS leave_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                start_time DATETIME NOT NULL,
                end_time DATETIME,
                planned_duration INTEGER, -- in minutes
                actual_duration INTEGER, -- in minutes
                reason TEXT NOT NULL,
                date TEXT NOT NULL, -- YYYY-MM-DD format
                is_half_day BOOLEAN DEFAULT FALSE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )`,
            
            `CREATE TABLE IF NOT EXISTS extra_work_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                start_time DATETIME NOT NULL,
                end_time DATETIME,
                duration INTEGER, -- in minutes
                date TEXT NOT NULL, -- YYYY-MM-DD format
                reason TEXT DEFAULT 'Compensating intermediate logout',
                work_description TEXT, -- What was worked on during the session
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )`,
            
            `CREATE TABLE IF NOT EXISTS daily_summaries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                date TEXT NOT NULL, -- YYYY-MM-DD format
                total_leave_minutes INTEGER DEFAULT 0,
                total_extra_work_minutes INTEGER DEFAULT 0,
                pending_extra_work_minutes INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id),
                UNIQUE(user_id, date)
            )`,

            `CREATE TABLE IF NOT EXISTS leave_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                user_name TEXT NOT NULL,
                leave_type TEXT NOT NULL, -- 'planned' or 'intermediate'
                reason TEXT NOT NULL,
                task_escalation TEXT,
                -- For intermediate logout
                planned_duration INTEGER, -- in minutes
                expected_return_time TEXT,
                -- For planned leave
                start_date TEXT,
                end_date TEXT,
                leave_duration_days INTEGER,
                -- Approval workflow
                status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'denied'
                approved_by TEXT,
                approved_at DATETIME,
                approval_notes TEXT,
                -- Timestamps
                requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )`
        ];

        let completedQueries = 0;
        const totalQueries = queries.length;

        queries.forEach(query => {
            this.db.run(query, (err) => {
                if (err) console.error('Database initialization error:', err);
                
                completedQueries++;
                
                // Only run migration after all tables are created
                if (completedQueries === totalQueries) {
                    this.runMigrations();
                }
            });
        });
    }

    runMigrations() {
        // Migration: Add work_description column if it doesn't exist
        // This migration is safe to run multiple times due to error checking
        this.db.run(
            `ALTER TABLE extra_work_sessions ADD COLUMN work_description TEXT`,
            (err) => {
                if (err) {
                    // This is expected if the column already exists
                    if (err.message.includes('duplicate column name')) {
                        console.log('✅ Migration: work_description column already exists');
                    } else {
                        console.error('Migration error:', err);
                    }
                } else {
                    console.log('✅ Migration: Added work_description column to extra_work_sessions');
                }
            }
        );

        // Migration: Add departure_time column to leave_requests table
        this.db.run(
            `ALTER TABLE leave_requests ADD COLUMN departure_time TEXT`,
            (err) => {
                if (err) {
                    // This is expected if the column already exists
                    if (err.message.includes('duplicate column name')) {
                        console.log('✅ Migration: departure_time column already exists');
                    } else {
                        console.error('Migration error:', err);
                    }
                } else {
                    console.log('✅ Migration: Added departure_time column to leave_requests');
                }
            }
        );

        // Migration: Add leave_date column to leave_requests table for future date scheduling
        this.db.run(
            `ALTER TABLE leave_requests ADD COLUMN leave_date TEXT`,
            (err) => {
                if (err) {
                    // This is expected if the column already exists
                    if (err.message.includes('duplicate column name')) {
                        console.log('✅ Migration: leave_date column already exists');
                    } else {
                        console.error('Migration error:', err);
                    }
                } else {
                    console.log('✅ Migration: Added leave_date column to leave_requests');
                }
            }
        );
    }

    // User management
    async createUser(userId, name, email = null) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT OR REPLACE INTO users (id, name, email) VALUES (?, ?, ?)',
                [userId, name, email],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID || userId);
                }
            );
        });
    }

    // Leave session management
    async startLeaveSession(userId, plannedDuration, reason) {
        const now = new Date();
        const date = now.toISOString().split('T')[0];
        
        return new Promise((resolve, reject) => {
            // First check if user already has an active session
            this.db.get(
                `SELECT * FROM leave_sessions 
                WHERE user_id = ? AND end_time IS NULL 
                ORDER BY start_time DESC LIMIT 1`,
                [userId],
                (err, existingSession) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    
                    if (existingSession) {
                        reject(new Error('User already has an active leave session'));
                        return;
                    }
                    
                    // No existing session, create new one
                    this.db.run(
                        `INSERT INTO leave_sessions 
                        (user_id, start_time, planned_duration, reason, date) 
                        VALUES (?, ?, ?, ?, ?)`,
                        [userId, now.toISOString(), plannedDuration, reason, date],
                        function(err) {
                            if (err) reject(err);
                            else resolve(this.lastID);
                        }
                    );
                }
            );
        });
    }

    async endLeaveSession(userId) {
        const now = new Date();
        
        return new Promise((resolve, reject) => {
            // First get the active session
            this.db.get(
                `SELECT * FROM leave_sessions 
                WHERE user_id = ? AND end_time IS NULL 
                ORDER BY start_time DESC LIMIT 1`,
                [userId],
                (err, session) => {
                    if (err) reject(err);
                    else if (!session) reject(new Error('No active leave session found'));
                    else {
                        const startTime = new Date(session.start_time);
                        const actualDuration = Math.round((now - startTime) / (1000 * 60)); // in minutes
                        
                        this.db.run(
                            `UPDATE leave_sessions 
                            SET end_time = ?, actual_duration = ? 
                            WHERE id = ?`,
                            [now.toISOString(), actualDuration, session.id],
                            function(err) {
                                if (err) reject(err);
                                else resolve({ ...session, actualDuration, end_time: now.toISOString() });
                            }
                        );
                    }
                }
            );
        });
    }

    // Extend an active leave session
    async extendLeaveSession(sessionId, additionalMinutes) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT * FROM leave_sessions WHERE id = ? AND end_time IS NULL`,
                [sessionId],
                (err, session) => {
                    if (err) reject(err);
                    else if (!session) reject(new Error('No active leave session found with that ID'));
                    else {
                        const newPlannedDuration = session.planned_duration + additionalMinutes;
                        
                        this.db.run(
                            `UPDATE leave_sessions 
                            SET planned_duration = ? 
                            WHERE id = ?`,
                            [newPlannedDuration, sessionId],
                            function(err) {
                                if (err) reject(err);
                                else resolve({ 
                                    ...session, 
                                    planned_duration: newPlannedDuration,
                                    extended_by: additionalMinutes 
                                });
                            }
                        );
                    }
                }
            );
        });
    }

    // Extra work session management
    async startExtraWorkSession(userId, reason = 'Compensating intermediate logout') {
        const now = new Date();
        const date = now.toISOString().split('T')[0];
        
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT INTO extra_work_sessions 
                (user_id, start_time, reason, date) 
                VALUES (?, ?, ?, ?)`,
                [userId, now.toISOString(), reason, date],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }

    async endExtraWorkSession(userId, workDescription = null) {
        const now = new Date();
        
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT * FROM extra_work_sessions 
                WHERE user_id = ? AND end_time IS NULL 
                ORDER BY start_time DESC LIMIT 1`,
                [userId],
                (err, session) => {
                    if (err) reject(err);
                    else if (!session) reject(new Error('No active extra work session found'));
                    else {
                        const startTime = new Date(session.start_time);
                        const duration = Math.round((now - startTime) / (1000 * 60)); // in minutes
                        
                        this.db.run(
                            `UPDATE extra_work_sessions 
                            SET end_time = ?, duration = ?, work_description = ? 
                            WHERE id = ?`,
                            [now.toISOString(), duration, workDescription, session.id],
                            function(err) {
                                if (err) reject(err);
                                else resolve({ ...session, duration, end_time: now.toISOString(), work_description: workDescription });
                            }
                        );
                    }
                }
            );
        });
    }

    // Daily summary management
    async updateDailySummary(userId, date) {
        return new Promise((resolve, reject) => {
            // Calculate totals for the day
            const queries = [
                `SELECT COALESCE(SUM(CASE 
                    WHEN end_time IS NOT NULL THEN actual_duration 
                    ELSE ROUND((strftime('%s', 'now') - strftime('%s', start_time)) / 60.0)
                END), 0) as total_leave 
                FROM leave_sessions 
                WHERE user_id = ? AND date = ?`,
                
                `SELECT COALESCE(SUM(duration), 0) as total_extra_work 
                FROM extra_work_sessions 
                WHERE user_id = ? AND date = ? AND end_time IS NOT NULL`
            ];

            Promise.all(queries.map(query => 
                new Promise((res, rej) => {
                    this.db.get(query, [userId, date], (err, result) => {
                        if (err) rej(err);
                        else res(result);
                    });
                })
            )).then(([leaveResult, extraWorkResult]) => {
                const totalLeave = leaveResult.total_leave || 0;
                const totalExtraWork = extraWorkResult.total_extra_work || 0;
                
                // Only count leave time ≤ 2.5h (150 minutes) towards pending extra work
                // Leave time > 2.5h is handled as half-day leave and doesn't need compensation
                        const maxIntermediateMinutes = 2.5 * 60; // 150 minutes
        const compensatableLeave = Math.min(totalLeave, maxIntermediateMinutes);
                const pendingExtraWork = Math.max(0, compensatableLeave - totalExtraWork);

                this.db.run(
                    `INSERT OR REPLACE INTO daily_summaries 
                    (user_id, date, total_leave_minutes, total_extra_work_minutes, pending_extra_work_minutes, updated_at) 
                    VALUES (?, ?, ?, ?, ?, ?)`,
                    [userId, date, totalLeave, totalExtraWork, pendingExtraWork, new Date().toISOString()],
                    function(err) {
                        if (err) reject(err);
                        else resolve({ totalLeave, totalExtraWork, pendingExtraWork });
                    }
                );
            }).catch(reject);
        });
    }

    // Reporting queries
    async getUserDailySummary(userId, date) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT * FROM daily_summaries 
                WHERE user_id = ? AND date = ?`,
                [userId, date],
                (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                }
            );
        });
    }

    async getUserActiveLeaveSession(userId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT * FROM leave_sessions 
                WHERE user_id = ? AND end_time IS NULL 
                ORDER BY start_time DESC LIMIT 1`,
                [userId],
                (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                }
            );
        });
    }

    async getUserActiveExtraWorkSession(userId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT * FROM extra_work_sessions 
                WHERE user_id = ? AND end_time IS NULL 
                ORDER BY start_time DESC LIMIT 1`,
                [userId],
                (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                }
            );
        });
    }

    async getAllUsersWithPendingWork(days = 7) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        const cutoffDateStr = cutoffDate.toISOString().split('T')[0];

        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT u.id, u.name, ds.date, ds.pending_extra_work_minutes
                FROM users u
                JOIN daily_summaries ds ON u.id = ds.user_id
                WHERE ds.pending_extra_work_minutes > 0 
                AND ds.date >= ?
                ORDER BY ds.date ASC`,
                [cutoffDateStr],
                (err, results) => {
                    if (err) reject(err);
                    else resolve(results);
                }
            );
        });
    }

    async getAdminReport(startDate, endDate) {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT 
                    COALESCE(u.name, 'Unknown User') as name,
                    COALESCE(u.id, ls.user_id, ews.user_id, ds.user_id) as id,
                    COUNT(DISTINCT ls.id) as total_leave_sessions,
                    COALESCE(SUM(CASE 
                        WHEN ls.end_time IS NOT NULL THEN ls.actual_duration 
                        ELSE ROUND((strftime('%s', 'now') - strftime('%s', ls.start_time)) / 60.0)
                    END), 0) as total_leave_minutes,
                    COUNT(DISTINCT ews.id) as total_extra_work_sessions,
                    COALESCE(SUM(ews.duration), 0) as total_extra_work_minutes,
                    COALESCE(MAX(ds.pending_extra_work_minutes), 0) as total_pending_minutes
                FROM (
                    SELECT DISTINCT user_id FROM leave_sessions WHERE date BETWEEN ? AND ?
                    UNION 
                    SELECT DISTINCT user_id FROM extra_work_sessions WHERE date BETWEEN ? AND ?
                    UNION 
                    SELECT DISTINCT user_id FROM daily_summaries WHERE date BETWEEN ? AND ?
                    UNION
                    SELECT DISTINCT id as user_id FROM users
                ) all_users
                LEFT JOIN users u ON u.id = all_users.user_id
                LEFT JOIN leave_sessions ls ON all_users.user_id = ls.user_id 
                    AND ls.date BETWEEN ? AND ?
                LEFT JOIN extra_work_sessions ews ON all_users.user_id = ews.user_id 
                    AND ews.date BETWEEN ? AND ? AND ews.end_time IS NOT NULL
                LEFT JOIN daily_summaries ds ON all_users.user_id = ds.user_id 
                    AND ds.date BETWEEN ? AND ?
                GROUP BY all_users.user_id
                HAVING total_leave_sessions > 0 OR total_extra_work_sessions > 0 OR total_pending_minutes > 0
                ORDER BY total_leave_minutes DESC`,
                [startDate, endDate, startDate, endDate, startDate, endDate, startDate, endDate, startDate, endDate, startDate, endDate],
                (err, results) => {
                    if (err) reject(err);
                    else resolve(results);
                }
            );
        });
    }

    // Get detailed extra work sessions with descriptions for reports
    async getExtraWorkSessionsWithDescriptions(startDate, endDate) {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT ews.*, u.name as user_name 
                FROM extra_work_sessions ews
                JOIN users u ON ews.user_id = u.id
                WHERE ews.date BETWEEN ? AND ?
                AND ews.end_time IS NOT NULL
                AND ews.work_description IS NOT NULL
                ORDER BY ews.date DESC, ews.start_time DESC`,
                [startDate, endDate],
                (err, results) => {
                    if (err) reject(err);
                    else resolve(results || []);
                }
            );
        });
    }

    // Get user's recent extra work sessions with descriptions
    async getUserRecentExtraWorkSessions(userId, days = 7) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        const cutoffDateStr = cutoffDate.toISOString().split('T')[0];

        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT * FROM extra_work_sessions 
                WHERE user_id = ? 
                AND date >= ?
                AND end_time IS NOT NULL
                ORDER BY start_time DESC 
                LIMIT 5`,
                [userId, cutoffDateStr],
                (err, results) => {
                    if (err) reject(err);
                    else resolve(results || []);
                }
            );
        });
    }

    // Leave request management
    async createLeaveRequest(userId, userName, leaveType, reason, taskEscalation, additionalData = {}) {
        return new Promise((resolve, reject) => {
            const {
                plannedDuration,
                expectedReturnTime,
                departureTime,
                leaveDate,
                startDate,
                endDate,
                leaveDurationDays
            } = additionalData;

            this.db.run(
                `INSERT INTO leave_requests 
                (user_id, user_name, leave_type, reason, task_escalation, planned_duration, 
                expected_return_time, departure_time, leave_date, start_date, end_date, leave_duration_days) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, userName, leaveType, reason, taskEscalation, plannedDuration, 
                expectedReturnTime, departureTime, leaveDate, startDate, endDate, leaveDurationDays],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }

    async updateLeaveRequestStatus(requestId, status, approvedBy, approvalNotes = null) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE leave_requests 
                SET status = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP, approval_notes = ? 
                WHERE id = ?`,
                [status, approvedBy, approvalNotes, requestId],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    async getLeaveRequest(requestId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT * FROM leave_requests WHERE id = ?`,
                [requestId],
                (err, request) => {
                    if (err) reject(err);
                    else resolve(request);
                }
            );
        });
    }

    async getPendingLeaveRequests() {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT * FROM leave_requests 
                WHERE status = 'pending' 
                ORDER BY requested_at ASC`,
                (err, requests) => {
                    if (err) reject(err);
                    else resolve(requests);
                }
            );
        });
    }

    async getUserLeaveRequests(userId, limit = 10) {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT * FROM leave_requests 
                WHERE user_id = ? 
                ORDER BY requested_at DESC 
                LIMIT ?`,
                [userId, limit],
                (err, requests) => {
                    if (err) reject(err);
                    else resolve(requests);
                }
            );
        });
    }

    close() {
        this.db.close();
    }
}

module.exports = Database; 