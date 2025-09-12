const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const { sendOTP, verifyOTP } = require('./services/otpService');
const { getApiConfig, clearApiConfigCache, sendDynamicOTP } = require('./services/dynamicApiService');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'appointpro-secret-key';

// Middleware
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'http://localhost:8080', 
      'http://localhost:3000', 
      'https://appoinments.gsmarena1.com', 
      'https://31.97.206.5:2025',
    ];
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
};

app.use(cors(corsOptions));

// Additional CORS headers for debugging and fallback
app.use((req, res, next) => {
  // Set CORS headers
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400'); // 24 hours
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  next();
});

app.use(express.json());

// Health check endpoint for production debugging
app.get('/api/health', async (req, res) => {
  try {
    const healthData = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      database: 'unknown',
      version: '1.0.0'
    };

    // Test database connection
    if (pool) {
      try {
        const [testResult] = await pool.execute('SELECT 1 as test');
        if (testResult && testResult.length > 0) {
          healthData.database = 'connected';
        } else {
          healthData.database = 'connection_failed';
        }
      } catch (dbError) {
        healthData.database = `error: ${dbError.message}`;
      }
    } else {
      healthData.database = 'pool_not_initialized';
    }

    res.json(healthData);
  } catch (error) {
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// Test authentication endpoint
app.get('/api/test-auth', authenticateToken, async (req, res) => {
  try {
    res.json({
      status: 'authenticated',
      user_id: req.user.id,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

// Debug endpoint to check database configuration
app.get('/api/debug/db-config', authenticateToken, async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ error: 'Database pool not available' });
    }

    // Check SQL mode and basic config
    const [sqlMode] = await pool.execute('SELECT @@sql_mode as sql_mode');
    const [timeZone] = await pool.execute('SELECT @@time_zone as time_zone');
    const [version] = await pool.execute('SELECT VERSION() as version');
    
    // Check if Ziina API key exists
    const [ziinaConfig] = await pool.execute(
      'SELECT COUNT(*) as count FROM api_configurations WHERE service_name = "ziina" AND status = "active"'
    );

    res.json({
      sql_mode: sqlMode[0]?.sql_mode,
      time_zone: timeZone[0]?.time_zone,
      mysql_version: version[0]?.version,
      ziina_api_configured: ziinaConfig[0]?.count > 0,
      timestamp: new Date().toISOString(),
      environment: {
        NODE_ENV: process.env.NODE_ENV,
        DB_HOST: process.env.DB_HOST ? 'configured' : 'missing',
        DB_NAME: process.env.DB_NAME || 'default',
        JWT_SECRET: process.env.JWT_SECRET ? 'configured' : 'missing'
      }
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Test CORS endpoint
app.get('/api/test-cors', (req, res) => {
  res.json({ 
    message: 'CORS is working!', 
    origin: req.headers.origin,
    timestamp: new Date().toISOString(),
    headers: req.headers
  });
});

// Create a connection pool without specifying a database initially
const rootPool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  waitForConnections: true,
  connectionLimit: 5, // Reduced from 10 to 5
  queueLimit: 0,
  acquireTimeout: 60000,
  timeout: 60000
});

// Database name
const dbName = process.env.DB_NAME || 'appointpro';

// Initialize database and tables
async function initializeDatabase() {
  try {
    // Create a connection without prepared statements for DDL commands
    const connection = await rootPool.getConnection();
    
    // Create database if not exists - using query instead of execute
    await connection.query(`CREATE DATABASE IF NOT EXISTS ${dbName}`);
    
    // Release the initial connection
    connection.release();
    
    // Create a new pool that's already connected to the database
    const dbPool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: dbName,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });
    
    // Get a connection from the new pool
    const dbConnection = await dbPool.getConnection();
    
    // Create users table if not exists
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        phone VARCHAR(20) UNIQUE NOT NULL,
        fullName VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        address JSON NOT NULL,
        password VARCHAR(255) NOT NULL,
        role ENUM('user', 'manager', 'admin', 'super_admin') DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    
    // Create appointments table if not exists
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        service VARCHAR(100) NOT NULL,
        appointment_date DATE NOT NULL,
        appointment_time TIME NOT NULL,
        status ENUM('pending', 'confirmed', 'in-progress', 'completed', 'cancelled') DEFAULT 'pending',
        location JSON NOT NULL,
        price DECIMAL(10, 2) NOT NULL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    
    // Create user_addresses table if not exists
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS user_addresses (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        address_type VARCHAR(50) NOT NULL,
        address_line1 VARCHAR(255) NOT NULL,
        address_line2 VARCHAR(255),
        city VARCHAR(100) NOT NULL,
        state VARCHAR(100) NOT NULL,
        postal_code VARCHAR(20) NOT NULL,
        country VARCHAR(100) NOT NULL DEFAULT 'United States',
        is_default BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    
    // Create payments table if not exists
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        order_id VARCHAR(255) NOT NULL,
        payment_id VARCHAR(255) NOT NULL,
        amount DECIMAL(10, 2) NOT NULL,
        currency VARCHAR(10) NOT NULL DEFAULT 'AED',
        status ENUM('pending', 'completed', 'failed', 'cancelled') DEFAULT 'pending',
        payment_method VARCHAR(50) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_payment_id (payment_id),
        INDEX idx_order_id (order_id)
      )
    `);
    
    // Create support_tickets table if not exists
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        subject VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        status ENUM('open', 'in_progress', 'resolved', 'closed') DEFAULT 'open',
        priority ENUM('low', 'medium', 'high') DEFAULT 'medium',
        admin_response TEXT NULL,
        admin_id INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    
    // Add missing columns to support_tickets table if they don't exist
    try {
      await dbConnection.query(`
        ALTER TABLE support_tickets 
        ADD COLUMN IF NOT EXISTS priority ENUM('low', 'medium', 'high') DEFAULT 'medium'
      `);
    } catch (error) {
      // Column might already exist, ignore error
      console.log('Priority column already exists or error adding it:', error.message);
    }
    
    try {
      await dbConnection.query(`
        ALTER TABLE support_tickets 
        ADD COLUMN IF NOT EXISTS admin_response TEXT NULL
      `);
    } catch (error) {
      // Column might already exist, ignore error
      console.log('Admin response column already exists or error adding it:', error.message);
    }
    
    try {
      await dbConnection.query(`
        ALTER TABLE support_tickets 
        ADD COLUMN IF NOT EXISTS admin_id INT NULL
      `);
    } catch (error) {
      // Column might already exist, ignore error
      console.log('Admin ID column already exists or error adding it:', error.message);
    }
    
    try {
      await dbConnection.query(`
        ALTER TABLE support_tickets 
        ADD CONSTRAINT fk_support_tickets_admin 
        FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL
      `);
    } catch (error) {
      // Constraint might already exist, ignore error
      console.log('Admin foreign key already exists or error adding it:', error.message);
    }
    
    // Create available_dates table if not exists
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS available_dates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        date DATE NOT NULL,
        service_category_id INT NULL,
        is_available BOOLEAN DEFAULT TRUE,
        max_appointments INT DEFAULT 10,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (service_category_id) REFERENCES service_categories(id) ON DELETE CASCADE,
        INDEX idx_date_category (date, service_category_id)
      )
    `);
    
    // Create available_time_slots table if not exists
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS available_time_slots (
        id INT AUTO_INCREMENT PRIMARY KEY,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        is_available BOOLEAN DEFAULT TRUE,
        extra_price DECIMAL(10,2) DEFAULT 0.00 COMMENT 'Additional charge for this time slot in AED',
        date DATE NOT NULL,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        UNIQUE KEY unique_time_slot (date, start_time, end_time)
      )
    `);
    
    // Create api_configurations table for dynamic API management
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS api_configurations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        service_name VARCHAR(50) NOT NULL UNIQUE,
        api_key TEXT NOT NULL,
        additional_config JSON NULL,
        status ENUM('active', 'inactive', 'testing') DEFAULT 'active',
        last_tested TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Create page_contents table to store editable page data (footer, faq, terms, privacy, careers, etc.)
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS page_contents (
        id INT AUTO_INCREMENT PRIMARY KEY,
        slug VARCHAR(100) NOT NULL UNIQUE,
        title VARCHAR(255) NULL,
        meta JSON NULL,
        content JSON NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    // Create dedicated content tables for website pages
    
    // FAQs table
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS faqs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        category VARCHAR(100) NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        sort_order INT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_category (category),
        INDEX idx_sort_order (sort_order)
      )
    `);

    // Terms of Service table
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS terms (
        id INT AUTO_INCREMENT PRIMARY KEY,
        section_title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        sort_order INT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_sort_order (sort_order)
      )
    `);

    // Privacy Policy table
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS privacy_policy (
        id INT AUTO_INCREMENT PRIMARY KEY,
        section_title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        sort_order INT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_sort_order (sort_order)
      )
    `);

    // Sitemap table
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS sitemap (
        id INT AUTO_INCREMENT PRIMARY KEY,
        section_name VARCHAR(100) NOT NULL,
        page_title VARCHAR(255) NOT NULL,
        page_url VARCHAR(500) NOT NULL,
        sort_order INT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_section (section_name),
        INDEX idx_sort_order (sort_order)
      )
    `);

    // Careers table
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS careers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        job_title VARCHAR(255) NOT NULL,
        department VARCHAR(100) NOT NULL,
        location VARCHAR(100) NOT NULL,
        job_type ENUM('full-time', 'part-time', 'contract', 'internship') DEFAULT 'full-time',
        description TEXT NOT NULL,
        requirements TEXT,
        benefits TEXT,
        salary_range VARCHAR(100),
        is_active BOOLEAN DEFAULT TRUE,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_department (department),
        INDEX idx_location (location),
        INDEX idx_job_type (job_type)
      )
    `);
    
    // Create service_categories table for dynamic service management
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS service_categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(100) NOT NULL UNIQUE,
        image_url VARCHAR(255),
        hero_image_url VARCHAR(255),
        description TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        sort_order INT DEFAULT 0,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    
    // Create property_types table for apartment/villa categories
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS property_types (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        slug VARCHAR(50) NOT NULL UNIQUE,
        image_url VARCHAR(255),
        description TEXT,
        base_price DECIMAL(10, 2) DEFAULT 0.00,
        is_active BOOLEAN DEFAULT TRUE,
        sort_order INT DEFAULT 0,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    
    // Create room_types table for different room configurations
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS room_types (
        id INT AUTO_INCREMENT PRIMARY KEY,
        property_type_id INT NOT NULL,
        name VARCHAR(50) NOT NULL,
        slug VARCHAR(50) NOT NULL,
        image_url VARCHAR(255),
        description TEXT,
        whats_included JSON DEFAULT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        sort_order INT DEFAULT 0,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (property_type_id) REFERENCES property_types(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        UNIQUE KEY unique_property_room (property_type_id, slug)
      )
    `);
    
    // Create service_items table for individual services within categories
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS service_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(100) NOT NULL UNIQUE,
        category_id INT NOT NULL,
        image_url VARCHAR(255),
        description TEXT,
        rating_text VARCHAR(100) DEFAULT '4.7/5 (15K bookings)',
        is_active BOOLEAN DEFAULT TRUE,
        sort_order INT DEFAULT 0,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (category_id) REFERENCES service_categories(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    // Create service_items_category table for categorizing service items in Step One
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS service_items_category (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(100) NOT NULL UNIQUE,
        description TEXT,
        parent_service_item_id INT,
        image_url VARCHAR(255),
        hero_image_url VARCHAR(255),
        icon_url VARCHAR(255),
        is_active BOOLEAN DEFAULT TRUE,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (parent_service_item_id) REFERENCES service_items(id) ON DELETE SET NULL
      )
    `);
    
    // Migration: Update service_items_category to use parent_service_item_id instead of parent_category_id
    try {
      // Check if old column exists
      const [oldColumns] = await dbConnection.query(`
        SHOW COLUMNS FROM service_items_category LIKE 'parent_category_id'
      `);
      
      // Check if new column exists
      const [newColumns] = await dbConnection.query(`
        SHOW COLUMNS FROM service_items_category LIKE 'parent_service_item_id'
      `);
      
      if (oldColumns.length > 0 && newColumns.length === 0) {
        console.log('Migrating service_items_category from parent_category_id to parent_service_item_id...');
        
        // Add new column
        await dbConnection.query(`
          ALTER TABLE service_items_category 
          ADD COLUMN parent_service_item_id INT
        `);
        
        // Note: Data migration would need manual mapping since we're changing the relationship
        // For now, we'll just drop the old column and add the new one
        
        // Drop old foreign key constraint if it exists
        try {
          await dbConnection.query(`
            ALTER TABLE service_items_category 
            DROP FOREIGN KEY service_items_category_ibfk_1
          `);
        } catch (fkError) {
          console.log('Old foreign key constraint might not exist:', fkError.message);
        }
        
        // Drop old column
        await dbConnection.query(`
          ALTER TABLE service_items_category 
          DROP COLUMN parent_category_id
        `);
        
        // Add new foreign key constraint
        try {
          await dbConnection.query(`
            ALTER TABLE service_items_category 
            ADD FOREIGN KEY (parent_service_item_id) REFERENCES service_items(id) ON DELETE SET NULL
          `);
        } catch (fkError) {
          console.log('Error adding new foreign key constraint:', fkError.message);
        }
        
        console.log('Migration completed: service_items_category now uses parent_service_item_id');
      } else if (newColumns.length === 0) {
        // Fresh installation - add parent_service_item_id column
        await dbConnection.query(`
          ALTER TABLE service_items_category 
          ADD COLUMN parent_service_item_id INT
        `);
        
        // Add foreign key constraint
        try {
          await dbConnection.query(`
            ALTER TABLE service_items_category 
            ADD FOREIGN KEY (parent_service_item_id) REFERENCES service_items(id) ON DELETE SET NULL
          `);
        } catch (fkError) {
          console.log('Foreign key constraint might already exist:', fkError.message);
        }
        
        console.log('Added parent_service_item_id column to service_items_category table');
      } else {
        console.log('parent_service_item_id column already exists in service_items_category table');
      }
    } catch (error) {
      console.log('Error during service_items_category migration:', error.message);
    }
    
    // Create junction table for service_items_category and property_types
    await dbConnection.execute(`
      CREATE TABLE IF NOT EXISTS service_items_category_property_types (
        id INT AUTO_INCREMENT PRIMARY KEY,
        service_items_category_id INT NOT NULL,
        property_type_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (service_items_category_id) REFERENCES service_items_category(id) ON DELETE CASCADE,
        FOREIGN KEY (property_type_id) REFERENCES property_types(id) ON DELETE CASCADE,
        UNIQUE KEY unique_category_property (service_items_category_id, property_type_id)
      )
    `);
    console.log('Created service_items_category_property_types junction table');
    
    // Create service_pricing table for category-property-room specific pricing
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS service_pricing (
        id INT AUTO_INCREMENT PRIMARY KEY,
        service_category_id INT NOT NULL,
        property_type_id INT NOT NULL,
        room_type_id INT NOT NULL,
        service_item_id INT NULL,
        price DECIMAL(10, 2) NOT NULL,
        discount_price DECIMAL(10, 2) NULL,
        max_orders INT DEFAULT NULL,
        description TEXT,
        is_special BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (service_category_id) REFERENCES service_categories(id) ON DELETE CASCADE,
        FOREIGN KEY (property_type_id) REFERENCES property_types(id) ON DELETE CASCADE,
        FOREIGN KEY (room_type_id) REFERENCES room_types(id) ON DELETE CASCADE,
        FOREIGN KEY (service_item_id) REFERENCES service_items(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        UNIQUE KEY unique_service_pricing (service_category_id, property_type_id, room_type_id, service_item_id)
      )
    `);

    // Create website_settings table for storing website configuration
    await dbConnection.query(`
      CREATE TABLE IF NOT EXISTS website_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        site_name VARCHAR(255) NOT NULL DEFAULT 'JL Services',
        logo_url VARCHAR(500) DEFAULT '/jl-logo.svg',
        tagline VARCHAR(255) DEFAULT 'Your trusted home services partner',
        primary_color VARCHAR(7) DEFAULT '#FFD03E',
        facebook_url VARCHAR(500) DEFAULT '',
        instagram_url VARCHAR(500) DEFAULT '',
        twitter_url VARCHAR(500) DEFAULT '',
        linkedin_url VARCHAR(500) DEFAULT '',
        google_url VARCHAR(500) DEFAULT '',
        whatsapp_url VARCHAR(500) DEFAULT '',
        contact_address TEXT DEFAULT '1403, Fortune Executive Tower, Cluster T, JLT, Dubai, UAE.',
        contact_phone VARCHAR(50) DEFAULT '+971 4 506 1500',
        contact_email VARCHAR(255) DEFAULT 'support@servicemarket.com',
        is_active BOOLEAN DEFAULT TRUE,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    
    console.log('Database and tables initialized successfully');
    
    // Migration: Add missing columns to existing appointments table if they don't exist
    try {
      // Check if room_type column exists
      const [roomTypeColumn] = await dbConnection.query(`
        SHOW COLUMNS FROM appointments LIKE 'room_type'
      `);
      
      if (roomTypeColumn.length === 0) {
        console.log('Adding missing columns to existing appointments table...');
        
        // Add room_type column
        await dbConnection.query(`
          ALTER TABLE appointments 
          ADD COLUMN room_type VARCHAR(100)
        `);
        
        // Add property_type column
        await dbConnection.query(`
          ALTER TABLE appointments 
          ADD COLUMN property_type VARCHAR(100)
        `);
        
        // Add quantity column
        await dbConnection.query(`
          ALTER TABLE appointments 
          ADD COLUMN quantity INT DEFAULT 1
        `);
        
        // Add service_category column
        await dbConnection.query(`
          ALTER TABLE appointments 
          ADD COLUMN service_category VARCHAR(100)
        `);
        
        console.log('Migration completed: existing appointments table now includes room_type, property_type, quantity, and service_category columns');
      } else {
        console.log('All required columns already exist in appointments table');
      }
    } catch (error) {
      console.log('Error during appointments table migration:', error.message);
    }

    // Migration: Add contact fields to website_settings table if they don't exist
    try {
      const [contactAddressColumn] = await dbConnection.query(`
        SHOW COLUMNS FROM website_settings LIKE 'contact_address'
      `);
      
      if (contactAddressColumn.length === 0) {
        console.log('Adding contact fields to website_settings table...');
        
        await dbConnection.query(`
          ALTER TABLE website_settings 
          ADD COLUMN contact_address TEXT DEFAULT '1403, Fortune Executive Tower, Cluster T, JLT, Dubai, UAE.'
        `);
        
        await dbConnection.query(`
          ALTER TABLE website_settings 
          ADD COLUMN contact_phone VARCHAR(50) DEFAULT '+971 4 506 1500'
        `);
        
        await dbConnection.query(`
          ALTER TABLE website_settings 
          ADD COLUMN contact_email VARCHAR(255) DEFAULT 'support@servicemarket.com'
        `);
        
        console.log('Migration completed: website_settings table now includes contact fields');
      } else {
        console.log('Contact fields already exist in website_settings table');
      }
    } catch (error) {
      console.log('Error during website_settings contact fields migration:', error.message);
    }

    // Migration: Add rating_text field to service_items table if it doesn't exist
    try {
      const [ratingTextColumn] = await dbConnection.query(`
        SHOW COLUMNS FROM service_items LIKE 'rating_text'
      `);
      
      if (ratingTextColumn.length === 0) {
        console.log('Adding rating_text column to service_items table...');
        await dbConnection.query(`
          ALTER TABLE service_items 
          ADD COLUMN rating_text VARCHAR(100) DEFAULT '4.7/5 (15K bookings)'
        `);
        console.log('Migration completed: service_items table now includes rating_text column');
      } else {
        console.log('rating_text column already exists in service_items table');
      }
    } catch (error) {
      console.log('Error during service_items rating_text migration:', error.message);
    }

    // Migration: Add whats_included field to room_types table if it doesn't exist
    try {
      const [whatsIncludedColumn] = await dbConnection.query(`
        SHOW COLUMNS FROM room_types LIKE 'whats_included'
      `);
      
      if (whatsIncludedColumn.length === 0) {
        console.log('Adding whats_included column to room_types table...');
        await dbConnection.query(`
          ALTER TABLE room_types 
          ADD COLUMN whats_included JSON DEFAULT NULL
        `);
        console.log('Migration completed: room_types table now includes whats_included column');
      } else {
        console.log('whats_included column already exists in room_types table');
      }
    } catch (error) {
      console.log('Error during room_types whats_included migration:', error.message);
    }

    // Migration: Add service_category_id to available_dates table if it doesn't exist
    try {
      const [serviceCategoryColumn] = await dbConnection.query(`
        SHOW COLUMNS FROM available_dates LIKE 'service_category_id'
      `);
      
      if (serviceCategoryColumn.length === 0) {
        console.log('Adding service_category_id column to available_dates table...');
        
        // First, drop the unique constraint on date if it exists
        try {
          await dbConnection.query(`
            ALTER TABLE available_dates DROP INDEX date
          `);
          console.log('Dropped unique constraint on date column');
        } catch (error) {
          console.log('Unique constraint on date column might not exist:', error.message);
        }
        
        // Add service_category_id column
        await dbConnection.query(`
          ALTER TABLE available_dates 
          ADD COLUMN service_category_id INT NULL AFTER date
        `);
        
        // Add foreign key constraint
        await dbConnection.query(`
          ALTER TABLE available_dates 
          ADD CONSTRAINT fk_available_dates_service_category 
          FOREIGN KEY (service_category_id) REFERENCES service_categories(id) ON DELETE CASCADE
        `);
        
        // Add index for better performance
        await dbConnection.query(`
          ALTER TABLE available_dates 
          ADD INDEX idx_date_category (date, service_category_id)
        `);
        
        console.log('Migration completed: available_dates table now includes service_category_id column');
      } else {
        console.log('service_category_id column already exists in available_dates table');
      }
    } catch (error) {
      console.log('Error during available_dates service_category_id migration:', error.message);
    }

    // Migration: Add service_category_id to available_time_slots table if it doesn't exist
    try {
      const [timeSlotsServiceCategoryColumn] = await dbConnection.query(`
        SHOW COLUMNS FROM available_time_slots LIKE 'service_category_id'
      `);
      
      if (timeSlotsServiceCategoryColumn.length === 0) {
        console.log('Adding service_category_id column to available_time_slots table...');
        
        // Add service_category_id column
        await dbConnection.query(`
          ALTER TABLE available_time_slots 
          ADD COLUMN service_category_id INT NULL AFTER date
        `);
        
        // Add foreign key constraint
        await dbConnection.query(`
          ALTER TABLE available_time_slots 
          ADD CONSTRAINT fk_time_slots_service_category 
          FOREIGN KEY (service_category_id) REFERENCES service_categories(id) ON DELETE CASCADE
        `);
        
        // Add index for better performance
        await dbConnection.query(`
          ALTER TABLE available_time_slots 
          ADD INDEX idx_time_slots_date_category (date, service_category_id)
        `);
        
        console.log('Migration completed: available_time_slots table now includes service_category_id column');
      } else {
        console.log('service_category_id column already exists in available_time_slots table');
      }
    } catch (error) {
      console.log('Error during available_time_slots service_category_id migration:', error.message);
    }

    // Migration: Add discount_price field to service_pricing table if it doesn't exist
    try {
      const [columns] = await dbConnection.query(
        'SHOW COLUMNS FROM service_pricing LIKE \'discount_price\''
      );
      if (columns.length === 0) {
        console.log('Adding discount_price column to service_pricing table...');
        await dbConnection.query(`
          ALTER TABLE service_pricing 
          ADD COLUMN discount_price DECIMAL(10, 2) NULL AFTER price
        `);
        console.log('Migration completed: service_pricing table now includes discount_price column');
      } else {
        console.log('discount_price column already exists in service_pricing table');
      }
    } catch (error) {
      console.log('Error during service_pricing discount_price migration:', error.message);
    }

    // Migration: Add max_orders field to service_pricing table if it doesn't exist
    try {
      const [columns] = await dbConnection.query(
        'SHOW COLUMNS FROM service_pricing LIKE \'max_orders\''
      );
      if (columns.length === 0) {
        console.log('Adding max_orders column to service_pricing table...');
        await dbConnection.query(`
          ALTER TABLE service_pricing 
          ADD COLUMN max_orders INT DEFAULT NULL
        `);
        console.log('Migration completed: service_pricing table now includes max_orders column');
      } else {
        console.log('max_orders column already exists in service_pricing table');
      }
    } catch (error) {
      console.log('Error during service_pricing max_orders migration:', error.message);
    }

    // Migration: Add slug columns to appointments table if they don't exist
    try {
      const [propertyTypeSlugColumn] = await dbConnection.query(`
        SHOW COLUMNS FROM appointments LIKE 'property_type_slug'
      `);
      
      if (propertyTypeSlugColumn.length === 0) {
        console.log('Adding slug columns to appointments table...');
        
        // Add property_type_slug column
        await dbConnection.query(`
          ALTER TABLE appointments 
          ADD COLUMN property_type_slug VARCHAR(100)
        `);
        
        // Add room_type_slug column
        await dbConnection.query(`
          ALTER TABLE appointments 
          ADD COLUMN room_type_slug VARCHAR(100)
        `);
        
        // Add service_category_slug column
        await dbConnection.query(`
          ALTER TABLE appointments 
          ADD COLUMN service_category_slug VARCHAR(100)
        `);
        
        // Add extra fields for better order tracking
        await dbConnection.query(`
          ALTER TABLE appointments 
          ADD COLUMN extra_price DECIMAL(10, 2) DEFAULT 0.00
        `);
        
        await dbConnection.query(`
          ALTER TABLE appointments 
          ADD COLUMN cod_fee DECIMAL(10, 2) DEFAULT 0.00
        `);
        
        await dbConnection.query(`
          ALTER TABLE appointments 
          ADD COLUMN payment_method VARCHAR(50)
        `);
        
        console.log('Migration completed: appointments table now includes slug columns and payment tracking fields');
      } else {
        console.log('Slug columns already exist in appointments table');
      }
    } catch (error) {
      console.log('Error during appointments slug columns migration:', error.message);
    }
    
    // Seed initial data
    await seedInitialData(dbConnection);
    
    dbConnection.release();
    
    // Return the configured pool for the application to use
    return dbPool;
  } catch (error) {
    console.error('Error initializing database:', error);
    process.exit(1); // Exit if database initialization fails
  }
}

// Create a connection pool for the application after database is initialized
let pool;

// Function to seed initial data
async function seedInitialData(connection) {
  try {
    // Check if time slots already exist
    const [timeSlotCount] = await connection.query('SELECT COUNT(*) as count FROM available_time_slots');
    
    if (timeSlotCount[0].count === 0) {
      console.log('Seeding initial time slots...');
      const timeSlots = [
        ['09:00:00', '09:30:00'],
        ['10:00:00', '10:30:00'],
        ['11:00:00', '11:30:00'],
        ['14:00:00', '14:30:00'], // 2:00 PM - 2:30 PM
        ['15:00:00', '15:30:00'], // 3:00 PM - 3:30 PM
        ['16:00:00', '16:30:00']  // 4:00 PM - 4:30 PM
      ];
      
      // Get today's date for seeding
      const today = new Date();
      const formattedDate = today.toISOString().split('T')[0]; // YYYY-MM-DD format
      
      for (const [start_time, end_time] of timeSlots) {
        await connection.query(
          'INSERT INTO available_time_slots (start_time, end_time, is_available, extra_price, date) VALUES (?, ?, TRUE, 0.00, ?)',
          [start_time, end_time, formattedDate]
        );
      }
      console.log('Time slots seeded successfully');
    }
    
    // Check if dates already exist
    const [dateCount] = await connection.query('SELECT COUNT(*) as count FROM available_dates');
    
    if (dateCount[0].count === 0) {
      console.log('Seeding initial available dates...');
      
      // Add next 30 days as available dates
      const today = new Date();
      for (let i = 0; i < 30; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() + i);
        
        // Skip Sundays (0 = Sunday)
        if (date.getDay() !== 0) {
          const formattedDate = date.toISOString().split('T')[0]; // YYYY-MM-DD format
          
          await connection.query(
            'INSERT INTO available_dates (date, is_available, max_appointments) VALUES (?, TRUE, 10)',
            [formattedDate]
          );
        }
      }
      console.log('Available dates seeded successfully');
    }
    
    // Check if service categories already exist
    const [categoryCount] = await connection.query('SELECT COUNT(*) as count FROM service_categories');
    
    if (categoryCount[0].count === 0) {
      console.log('Seeding initial service categories...');
      const categories = [
        {
          name: 'General',
          slug: 'general',
          image_url: '/general_cleaning/homecleaning.webp',
          hero_image_url: '/steps/s1.png',
          description: 'General cleaning and maintenance services',
          sort_order: 1
        },
        {
          name: 'Cockroaches',
          slug: 'cockroaches',
          image_url: '/pest.webp',
          hero_image_url: '/steps/s2.png',
          description: 'Professional cockroach pest control services',
          sort_order: 2
        },
        {
          name: 'Ants',
          slug: 'ants',
          image_url: '/pest.webp',
          hero_image_url: '/steps/s3.png',
          description: 'Effective ant control and elimination',
          sort_order: 3
        },
        {
          name: 'Mosquitoes',
          slug: 'mosquitoes',
          image_url: '/pest.webp',
          hero_image_url: '/steps/s4.png',
          description: 'Mosquito control and prevention services',
          sort_order: 4
        },
        {
          name: 'Bed Bugs',
          slug: 'bed-bugs',
          image_url: '/pest.webp',
          hero_image_url: '/steps/s5.png',
          description: 'Specialized bed bug treatment and elimination',
          sort_order: 5
        }
      ];
      
      for (const category of categories) {
        await connection.query(
          'INSERT INTO service_categories (name, slug, image_url, hero_image_url, description, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
          [category.name, category.slug, category.image_url, category.hero_image_url, category.description, category.sort_order]
        );
      }
      console.log('Service categories seeded successfully');
    }
    
    // Check if property types already exist
    const [propertyCount] = await connection.query('SELECT COUNT(*) as count FROM property_types');
    
    if (propertyCount[0].count === 0) {
      console.log('Seeding initial property types...');
      const propertyTypes = [
        {
          name: 'Apartment',
          slug: 'apartment',
          image_url: '/steps/apart.png',
          description: 'Get rid of common pests and keep your home safe with General Pest Control.',
          base_price: 199.00,
          sort_order: 1
        },
        {
          name: 'Villa',
          slug: 'villa',
          image_url: '/steps/villa.png',
          description: 'Keep your villa pest-free with our easy and effective General Pest Control service.',
          base_price: 299.00,
          sort_order: 2
        }
      ];
      
      for (const property of propertyTypes) {
        await connection.query(
          'INSERT INTO property_types (name, slug, image_url, description, base_price, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
          [property.name, property.slug, property.image_url, property.description, property.base_price, property.sort_order]
        );
      }
      console.log('Property types seeded successfully');
    }
    
    // Check if room types already exist
    const [roomCount] = await connection.query('SELECT COUNT(*) as count FROM room_types');
    
    if (roomCount[0].count === 0) {
      console.log('Seeding initial room types...');
      
      // Get property type IDs
      const [apartmentResult] = await connection.query('SELECT id FROM property_types WHERE slug = ?', ['apartment']);
      const [villaResult] = await connection.query('SELECT id FROM property_types WHERE slug = ?', ['villa']);
      
      const apartmentId = apartmentResult[0].id;
      const villaId = villaResult[0].id;
      
      const roomTypes = [
        // Apartment rooms
        { property_type_id: apartmentId, name: 'Studio', slug: 'studio', image_url: '/steps/apart/1.png', sort_order: 1 },
        { property_type_id: apartmentId, name: '1 Bedroom Apartment', slug: '1bed', image_url: '/steps/apart/2.png', sort_order: 2 },
        { property_type_id: apartmentId, name: '2 Bedroom', slug: '2bed', image_url: '/steps/apart/3.png', sort_order: 3 },
        { property_type_id: apartmentId, name: '3 Bedroom', slug: '3bed', image_url: '/steps/apart/4.png', sort_order: 4 },
        { property_type_id: apartmentId, name: '4 Bedroom', slug: '4bed', image_url: '/steps/apart/5.png', sort_order: 5 },
        
        // Villa rooms
        { property_type_id: villaId, name: '2 Bedroom', slug: '2bed', image_url: '/steps/villa/1.png', sort_order: 1 },
        { property_type_id: villaId, name: '3 Bedroom', slug: '3bed', image_url: '/steps/villa/2.png', sort_order: 2 },
        { property_type_id: villaId, name: '4 Bedroom', slug: '4bed', image_url: '/steps/villa/3.png', sort_order: 3 },
        { property_type_id: villaId, name: '5 Bedroom', slug: '5bed', image_url: '/steps/villa/4.png', sort_order: 4 }
      ];
      
      for (const room of roomTypes) {
        await connection.query(
          'INSERT INTO room_types (property_type_id, name, slug, image_url, sort_order) VALUES (?, ?, ?, ?, ?)',
          [room.property_type_id, room.name, room.slug, room.image_url, room.sort_order]
        );
      }
      console.log('Room types seeded successfully');
    }
    
    // Check if service pricing already exists
    const [pricingCount] = await connection.query('SELECT COUNT(*) as count FROM service_pricing');
    
    if (pricingCount[0].count === 0) {
      console.log('Seeding initial service pricing...');
      
      // Get all IDs needed for pricing
      const [categories] = await connection.query('SELECT id, slug FROM service_categories');
      const [properties] = await connection.query('SELECT id, slug FROM property_types');
      const [rooms] = await connection.query('SELECT id, slug, property_type_id FROM room_types');
      
      // Create a mapping for easier access
      const categoryMap = {};
      categories.forEach(cat => categoryMap[cat.slug] = cat.id);
      
      const propertyMap = {};
      properties.forEach(prop => propertyMap[prop.slug] = prop.id);
      
      // Hardcoded pricing data (same as the original ServiceOptionsModal)
      const pricingData = {
        apartment: {
          general: {
            studio: { price: 149, description: "Comprehensive cleaning service for studio apartments." },
            "1bed": { price: 179, description: "Comprehensive cleaning service for 1 bedroom apartments." },
            "2bed": { price: 199, description: "Comprehensive cleaning service for 2 bedroom apartments." },
            "3bed": { price: 229, description: "Comprehensive cleaning service for 3 bedroom apartments." },
            "4bed": { price: 249, description: "Comprehensive cleaning service for 4 bedroom apartments." }
          },
          cockroaches: {
            studio: { price: 129, description: "Professional cockroach control for studio apartments." },
            "1bed": { price: 159, description: "Professional cockroach control for 1 bedroom apartments." },
            "2bed": { price: 179, description: "Professional cockroach control for 2 bedroom apartments." },
            "3bed": { price: 209, description: "Professional cockroach control for 3 bedroom apartments.", special: true },
            "4bed": { price: 229, description: "Professional cockroach control for 4 bedroom apartments." }
          },
          ants: {
            studio: { price: 119, description: "Professional ant control for studio apartments." },
            "1bed": { price: 149, description: "Professional ant control for 1 bedroom apartments." },
            "2bed": { price: 169, description: "Professional ant control for 2 bedroom apartments." },
            "3bed": { price: 199, description: "Professional ant control for 3 bedroom apartments." },
            "4bed": { price: 219, description: "Professional ant control for 4 bedroom apartments." }
          },
          mosquitoes: {
            studio: { price: 139, description: "Professional mosquito control for studio apartments." },
            "1bed": { price: 169, description: "Professional mosquito control for 1 bedroom apartments." },
            "2bed": { price: 189, description: "Professional mosquito control for 2 bedroom apartments." },
            "3bed": { price: 219, description: "Professional mosquito control for 3 bedroom apartments." },
            "4bed": { price: 239, description: "Professional mosquito control for 4 bedroom apartments." }
          },
          "bed-bugs": {
            studio: { price: 159, description: "Professional bed bug control for studio apartments." },
            "1bed": { price: 189, description: "Professional bed bug control for 1 bedroom apartments." },
            "2bed": { price: 209, description: "Professional bed bug control for 2 bedroom apartments." },
            "3bed": { price: 239, description: "Professional bed bug control for 3 bedroom apartments." },
            "4bed": { price: 259, description: "Professional bed bug control for 4 bedroom apartments." }
          }
        },
        villa: {
          general: {
            "2bed": { price: 299, description: "Comprehensive cleaning service for 2 bedroom villas." },
            "3bed": { price: 349, description: "Comprehensive cleaning service for 3 bedroom villas." },
            "4bed": { price: 399, description: "Comprehensive cleaning service for 4 bedroom villas." },
            "5bed": { price: 449, description: "Comprehensive cleaning service for 5 bedroom villas." }
          },
          cockroaches: {
            "2bed": { price: 279, description: "Professional cockroach control for 2 bedroom villas." },
            "3bed": { price: 329, description: "Professional cockroach control for 3 bedroom villas." },
            "4bed": { price: 379, description: "Professional cockroach control for 4 bedroom villas." },
            "5bed": { price: 429, description: "Professional cockroach control for 5 bedroom villas." }
          },
          ants: {
            "2bed": { price: 259, description: "Professional ant control for 2 bedroom villas." },
            "3bed": { price: 309, description: "Professional ant control for 3 bedroom villas." },
            "4bed": { price: 359, description: "Professional ant control for 4 bedroom villas." },
            "5bed": { price: 409, description: "Professional ant control for 5 bedroom villas." }
          },
          mosquitoes: {
            "2bed": { price: 289, description: "Professional mosquito control for 2 bedroom villas." },
            "3bed": { price: 339, description: "Professional mosquito control for 3 bedroom villas." },
            "4bed": { price: 389, description: "Professional mosquito control for 4 bedroom villas." },
            "5bed": { price: 439, description: "Professional mosquito control for 5 bedroom villas." }
          },
          "bed-bugs": {
            "2bed": { price: 309, description: "Professional bed bug control for 2 bedroom villas." },
            "3bed": { price: 359, description: "Professional bed bug control for 3 bedroom villas.", special: true },
            "4bed": { price: 409, description: "Professional bed bug control for 4 bedroom villas." },
            "5bed": { price: 459, description: "Professional bed bug control for 5 bedroom villas." }
          }
        }
      };
      
      // Insert pricing data
      for (const [propertySlug, propertyData] of Object.entries(pricingData)) {
        const propertyId = propertyMap[propertySlug];
        
        for (const [categorySlug, categoryData] of Object.entries(propertyData)) {
          const categoryId = categoryMap[categorySlug];
          
          for (const [roomSlug, roomData] of Object.entries(categoryData)) {
            // Find the room ID
            const room = rooms.find(r => r.slug === roomSlug && r.property_type_id === propertyId);
            if (room) {
              await connection.query(
                'INSERT INTO service_pricing (service_category_id, property_type_id, room_type_id, price, description, is_special) VALUES (?, ?, ?, ?, ?, ?)',
                [categoryId, propertyId, room.id, roomData.price, roomData.description, roomData.special || false]
              );
            }
          }
        }
      }
      console.log('Service pricing seeded successfully');
    }

    // Check if website settings already exist
    const [websiteSettingsCount] = await connection.query('SELECT COUNT(*) as count FROM website_settings');
    
    if (websiteSettingsCount[0].count === 0) {
      console.log('Seeding initial website settings...');
      await connection.query(
        'INSERT INTO website_settings (site_name, logo_url, tagline, primary_color) VALUES (?, ?, ?, ?)',
        ['JL Services', '/jl-logo.svg', 'Your trusted home services partner', '#FFD03E']
      );
      console.log('Website settings seeded successfully');
    }
    
  } catch (error) {
    console.error('Error seeding initial data:', error);
  }
}

// API Routes

// Send OTP to phone number
app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    
    if (!phone) {
      return res.status(400).json({ message: 'Phone number is required' });
    }
    
    // First try to use dynamic Twilio configuration
    let result;
    try {
      // Generate OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      
      // Send OTP using dynamic Twilio configuration
      const smsResult = await sendDynamicOTP(phone, otp, pool);
      
      if (smsResult.success) {
        // Store OTP in temporary storage (you might want to use Redis or database)
        // For now, we'll use the same method as the original service
        result = await sendOTP(phone); // This will use the fallback service for OTP storage
        result.dynamicConfig = true;
      } else {
        // Fallback to original OTP service
        result = await sendOTP(phone);
        result.dynamicConfig = false;
      }
    } catch (error) {
      console.log('Dynamic Twilio failed, falling back to original service:', error.message);
      // Fallback to original OTP service
      result = await sendOTP(phone);
      result.dynamicConfig = false;
    }
    
    if (result.success) {
      // Include test OTP in response for development mode
      const response = { 
        message: result.message,
        success: true,
        usingDynamicConfig: result.dynamicConfig || false
      };
      
      // Add test info for development
      if (result.testMode) {
        response.testMode = true;
        response.testOtp = result.testOtp;
      }
      
      return res.json(response);
    } else {
      return res.status(500).json({ 
        message: result.message,
        success: false
      });
    }
  } catch (error) {
    console.error('Error sending OTP:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Verify OTP and login/register
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { phone, otp } = req.body;
    
    if (!phone || !otp) {
      return res.status(400).json({ message: 'Phone number and OTP are required' });
    }
    
    // Verify OTP
    const otpResult = verifyOTP(phone, otp);
    
    if (!otpResult.success) {
      return res.status(400).json({ 
        message: otpResult.message,
        success: false
      });
    }
    
    // Check if user exists
    const [userRows] = await pool.execute('SELECT * FROM users WHERE phone = ?', [phone]);
    
    if (userRows.length > 0) {
      // User exists - login
      const user = userRows[0];
      
      // Generate JWT token
      const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
      
      // Remove password from user object
      delete user.password;
      
      return res.json({
        message: 'Login successful',
        token,
        user,
        isNewUser: false
      });
    } else {
      // User doesn't exist - return flag for registration
      return res.json({
        message: 'Phone verified, please complete registration',
        phone,
        isNewUser: true,
        success: true
      });
    }
  } catch (error) {
    console.error('Error verifying OTP:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Check if phone number exists
app.post('/api/auth/check-phone', async (req, res) => {
  try {
    const { phone } = req.body;
    
    if (!phone) {
      return res.status(400).json({ message: 'Phone number is required' });
    }
    
    const [rows] = await pool.execute('SELECT id FROM users WHERE phone = ?', [phone]);
    
    return res.json({ exists: rows.length > 0 });
  } catch (error) {
    console.error('Error checking phone:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Register new user (modified for OTP flow)
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phone, fullName, email, address, password, isOtpVerified } = req.body;
    
    // Validate input - address is now optional since it's removed from frontend
    if (!phone || !fullName || !email) {
      return res.status(400).json({ message: 'Phone, name, and email are required' });
    }
    
    // For OTP flow, password is optional (can be set later)
    if (!isOtpVerified && !password) {
      return res.status(400).json({ message: 'Password is required for non-OTP registration' });
    }
    
    // Check if phone already exists
    const [phoneCheck] = await pool.execute('SELECT id FROM users WHERE phone = ?', [phone]);
    if (phoneCheck.length > 0) {
      return res.status(400).json({ message: 'Phone number already registered' });
    }
    
    // Check if email already exists
    const [emailCheck] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (emailCheck.length > 0) {
      return res.status(400).json({ message: 'Email already registered' });
    }
    
    // Hash password if provided, otherwise use a placeholder
    let hashedPassword = null;
    if (password) {
      hashedPassword = await bcrypt.hash(password, 10);
    } else {
      // For OTP users, create a placeholder password that they'll need to change
      hashedPassword = await bcrypt.hash(phone + '_temp_otp_password', 10);
    }
    
    // Use provided address or default empty address object for backward compatibility
    const addressJSON = JSON.stringify(address || {});
    
    // Insert new user
    const [result] = await pool.execute(
      'INSERT INTO users (phone, fullName, email, address, password) VALUES (?, ?, ?, ?, ?)',
      [phone, fullName, email, addressJSON, hashedPassword]
    );
    
    // Generate JWT token
    const user = {
      id: result.insertId,
      phone,
      fullName,
      email
    };
    
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    
    return res.status(201).json({ 
      message: 'User registered successfully',
      token,
      user
    });
  } catch (error) {
    console.error('Error registering user:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Login user
app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    
    // Validate input
    if (!phone || !password) {
      return res.status(400).json({ message: 'Phone and password are required' });
    }
    
    // Find user by phone
    const [rows] = await pool.execute('SELECT * FROM users WHERE phone = ?', [phone]);
    
    if (rows.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    const user = rows[0];
    
    // Compare password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    // Generate JWT token
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    
    // Remove password from user object
    delete user.password;
    
    return res.json({
      message: 'Login successful',
      token,
      user
    });
  } catch (error) {
    console.error('Error logging in:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// User Profile API
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT id, phone, fullName, email, address, role FROM users WHERE id = ?', [req.user.id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    return res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching profile:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Update user profile
app.put('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const { fullName, email, phone } = req.body;
    
    // Validate input
    if (!fullName && !email && !phone) {
      return res.status(400).json({ message: 'At least one field is required' });
    }
    
    // Build the update query dynamically based on provided fields
    let updateQuery = 'UPDATE users SET ';
    const updateValues = [];
    
    if (fullName) {
      updateQuery += 'fullName = ?, ';
      updateValues.push(fullName);
    }
    
    if (email) {
      updateQuery += 'email = ?, ';
      updateValues.push(email);
    }
    
    if (phone) {
      updateQuery += 'phone = ?, ';
      updateValues.push(phone);
    }
    
    // Remove trailing comma and space
    updateQuery = updateQuery.slice(0, -2);
    
    // Add WHERE clause
    updateQuery += ' WHERE id = ?';
    updateValues.push(req.user.id);
    
    // Execute the update
    await pool.execute(updateQuery, updateValues);
    
    return res.json({ message: 'Profile updated successfully' });
  } catch (error) {
    console.error('Error updating profile:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// User Appointments API

// Get all appointments for the user
app.get('/api/user/appointments', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT 
        id, user_id, service, appointment_date, appointment_time, status, 
        location, price, notes, room_type, room_type_slug, property_type, property_type_slug, 
        quantity, service_category, service_category_slug, extra_price, cod_fee, payment_method,
        created_at, updated_at
       FROM appointments WHERE user_id = ? ORDER BY appointment_date DESC, appointment_time DESC`,
      [req.user.id]
    );
    
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching appointments:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get single appointment by ID for the user
app.get('/api/user/appointments/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [rows] = await pool.execute(
      `SELECT 
        id, user_id, service, appointment_date, appointment_time, status, 
        location, price, notes, room_type, room_type_slug, property_type, property_type_slug, 
        quantity, service_category, service_category_slug, extra_price, cod_fee, payment_method,
        created_at, updated_at
       FROM appointments WHERE id = ? AND user_id = ?`,
      [id, req.user.id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Appointment not found or not authorized' });
    }
    
    return res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching appointment:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get upcoming appointments for the user
app.get('/api/user/appointments/upcoming', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM appointments 
       WHERE user_id = ? AND 
       (appointment_date > CURDATE() OR 
        (appointment_date = CURDATE() AND appointment_time >= CURTIME())) AND
       status NOT IN ('completed', 'cancelled')
       ORDER BY appointment_date ASC, appointment_time ASC`,
      [req.user.id]
    );
    
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching upcoming appointments:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get past appointments for the user
app.get('/api/user/appointments/past', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM appointments 
       WHERE user_id = ? AND 
       (appointment_date < CURDATE() OR 
        (appointment_date = CURDATE() AND appointment_time < CURTIME()) OR
        status = 'completed')
       ORDER BY appointment_date DESC, appointment_time DESC`,
      [req.user.id]
    );
    
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching past appointments:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Ziina Payment API endpoints

// Create Ziina payment
app.post('/api/payments/ziina/create', authenticateToken, async (req, res) => {
  try {
    const { amount, currency, description, order_id, customer_email, customer_phone, return_url, cancel_url } = req.body;
    
    console.log('Backend - Ziina payment creation request:', {
      amount,
      currency,
      description,
      order_id,
      customer_email,
      customer_phone,
      return_url,
      cancel_url,
      user_id: req.user.id
    });
    
    // Validate input
    if (!amount || !currency || !description || !order_id) {
      console.error('Backend - Missing required payment fields:', { amount, currency, description, order_id });
      return res.status(400).json({ message: 'Missing required payment fields' });
    }

    // Check if pool is available
    if (!pool) {
      console.error('Backend - Database pool not available');
      return res.status(500).json({ message: 'Database not available' });
    }

    // Get Ziina API key from database configuration
    const [ziinaConfigs] = await pool.execute(
      'SELECT api_key FROM api_configurations WHERE service_name = ? AND status = "active"',
      ['ziina']
    );
    
    if (ziinaConfigs.length === 0) {
      console.error('Backend - Ziina API key not configured in database');
      return res.status(500).json({ message: 'Ziina API key not configured in database' });
    }
    
    const ziinaApiKey = ziinaConfigs[0].api_key;
    console.log('Backend - Ziina API key from database:', ziinaApiKey ? 'Configured' : 'Not configured');

    // Create payment with Ziina API
    console.log('Backend - Making Ziina API request...');
    const ziinaPayload = {
      amount: amount * 100, // Convert to fils (100 AED = 10000 fils)
      currency_code: currency,
      success_url: return_url,
      cancel_url: cancel_url,
      test: true // Test mode for development
    };
    console.log('Backend - Ziina API payload:', ziinaPayload);
    
    const ziinaResponse = await fetch('https://api-v2.ziina.com/api/payment_intent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ziinaApiKey}`,
        'Accept': 'application/json'
      },
      body: JSON.stringify(ziinaPayload)
    });

    const ziinaData = await ziinaResponse.json();
    console.log('Backend - Ziina API response status:', ziinaResponse.status);
    console.log('Backend - Ziina API response:', ziinaData);

    if (!ziinaResponse.ok) {
      console.error('Backend - Ziina API error:', {
        status: ziinaResponse.status,
        statusText: ziinaResponse.statusText,
        data: ziinaData
      });
      return res.status(400).json({ 
        success: false,
        message: ziinaData.message || 'Failed to create payment with Ziina',
        error: ziinaData
      });
    }

    // Store payment record in database
    const paymentId = ziinaData.id;
    const [paymentResult] = await pool.execute(
      `INSERT INTO payments (user_id, order_id, payment_id, amount, currency, status, payment_method, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [req.user.id, order_id, paymentId, amount, currency, 'pending', 'ziina']
    );

    res.json({
      success: true,
      payment_id: ziinaData.id,
      payment_url: ziinaData.redirect_url,
      status: ziinaData.status || 'pending',
      message: 'Payment created successfully'
    });

  } catch (error) {
    console.error('Backend - Error creating Ziina payment:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    res.status(500).json({ 
      success: false,
      message: 'Internal server error during payment creation',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Get Ziina payment status
app.get('/api/payments/ziina/status/:paymentId', authenticateToken, async (req, res) => {
  try {
    const { paymentId } = req.params;
    
    // Get Ziina API key from database configuration
    const [ziinaConfigs] = await pool.execute(
      'SELECT api_key FROM api_configurations WHERE service_name = ? AND status = "active"',
      ['ziina']
    );
    
    if (ziinaConfigs.length === 0) {
      return res.status(500).json({ message: 'Ziina API key not configured in database' });
    }
    
    const ziinaApiKey = ziinaConfigs[0].api_key;

    // Get payment status from Ziina API
    const ziinaResponse = await fetch(`https://api-v2.ziina.com/api/payment_intent/${paymentId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${ziinaApiKey}`,
        'Accept': 'application/json'
      }
    });

    const ziinaData = await ziinaResponse.json();

    if (!ziinaResponse.ok) {
      console.error('Ziina API error:', ziinaData);
      return res.status(400).json({ 
        message: ziinaData.message || 'Failed to get payment status from Ziina'
      });
    }

    // Update payment status in database
    await pool.execute(
      'UPDATE payments SET status = ?, updated_at = NOW() WHERE payment_id = ?',
      [ziinaData.status, paymentId]
    );

    res.json({
      payment_id: ziinaData.payment_id,
      status: ziinaData.status,
      amount: ziinaData.amount / 100, // Convert from cents
      currency: ziinaData.currency,
      order_id: ziinaData.order_id,
      created_at: ziinaData.created_at,
      updated_at: ziinaData.updated_at
    });

  } catch (error) {
    console.error('Error getting Ziina payment status:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Ziina webhook handler
app.post('/api/payments/ziina/webhook', async (req, res) => {
  try {
    const { payment_id, status, order_id } = req.body;
    
    console.log('Ziina webhook received:', { payment_id, status, order_id });

    // Update payment status in database
    await pool.execute(
      'UPDATE payments SET status = ?, updated_at = NOW() WHERE payment_id = ?',
      [status, payment_id]
    );

    // Update appointment status if payment is completed
    if (status === 'completed' && order_id) {
      const appointmentId = order_id.replace('appointment_', '');
      await pool.execute(
        'UPDATE appointments SET status = ? WHERE id = ?',
        ['confirmed', appointmentId]
      );
    }

    res.status(200).json({ message: 'Webhook processed successfully' });

  } catch (error) {
    console.error('Error processing Ziina webhook:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Create a new appointment
app.post('/api/user/appointments', authenticateToken, async (req, res) => {
  try {
    // Check if pool is available
    if (!pool) {
      console.error('Backend - Database pool not available for appointment creation');
      return res.status(500).json({ message: 'Database not available' });
    }
    
    const { 
      service, 
      appointment_date, 
      appointment_time, 
      location, 
      price, 
      notes,
      room_type,
      room_type_slug,
      property_type,
      property_type_slug,
      quantity,
      service_category,
      service_category_slug,
      extra_price,
      cod_fee,
      payment_method,
      status
    } = req.body;
    
    // Debug: Log the received data
    console.log('Backend - Received appointment data:', {
      service,
      appointment_date,
      appointment_time,
      location,
      price,
      room_type,
      room_type_slug,
      property_type,
      property_type_slug,
      service_category,
      service_category_slug,
      extra_price,
      cod_fee,
      payment_method,
      status,
      user_id: req.user.id
    });
    console.log('Backend - Type of appointment_date:', typeof appointment_date);
    console.log('Backend - Raw appointment_time received:', appointment_time);
    
    // Helper function to extract and convert time
    const extractStartTime = (timeInput) => {
      if (!timeInput) return timeInput;
      
      // If it's already in correct format (like "14:00:00"), return as is
      if (timeInput.match(/^\d{2}:\d{2}(:\d{2})?$/)) {
        return timeInput;
      }
      
      // Extract start time from range like "2:00 PM - 2:30 PM"
      const startTimeStr = timeInput.split(' - ')[0];
      
      // Convert 12-hour format to 24-hour format for database
      const convertTo24Hour = (time12h) => {
        const [time, modifier] = time12h.trim().split(' ');
        let [hours, minutes] = time.split(':');
        
        if (hours === '12') {
          hours = '00';
        }
        
        if (modifier === 'PM') {
          hours = parseInt(hours, 10) + 12;
        }
        
        return `${hours.toString().padStart(2, '0')}:${minutes}:00`;
      };
      
      return convertTo24Hour(startTimeStr);
    };
    
    // Convert appointment_time to proper format
    const formattedTime = extractStartTime(appointment_time);
    console.log('Backend - Converted appointment_time:', formattedTime);
    
    // Validate input
    if (!service || !appointment_date || !appointment_time || !location || !price) {
      return res.status(400).json({ message: 'All required fields must be provided' });
    }
    
    // Validate and convert appointment_date to proper format
    let formattedDate;
    try {
      // Try to parse the date and convert to YYYY-MM-DD format
      const dateObj = new Date(appointment_date);
      if (isNaN(dateObj.getTime())) {
        throw new Error('Invalid date format');
      }
      formattedDate = dateObj.toISOString().split('T')[0]; // Get YYYY-MM-DD format
      console.log('Backend - Formatted date:', formattedDate);
    } catch (error) {
      console.error('Backend - Date parsing error:', error);
      return res.status(400).json({ message: 'Invalid date format. Please provide date in YYYY-MM-DD format' });
    }
    
    // Convert location object to JSON string
    const locationJSON = JSON.stringify(location);
    
    // Insert new appointment with new fields including slugs
    const [result] = await pool.execute(
      `INSERT INTO appointments 
       (user_id, service, appointment_date, appointment_time, location, price, notes, 
        room_type, room_type_slug, property_type, property_type_slug, quantity, 
        service_category, service_category_slug, extra_price, cod_fee, payment_method, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id, 
        service, 
        formattedDate, // Use the formatted date instead of raw appointment_date
        formattedTime, // Use the formatted time instead of raw appointment_time
        locationJSON, 
        price, 
        notes || null,
        room_type || null,
        room_type_slug || null,
        property_type || null,
        property_type_slug || null,
        quantity || 1,
        service_category || null,
        service_category_slug || null,
        extra_price || 0.00,
        cod_fee || 0.00,
        payment_method || null,
        status || 'pending'
      ]
    );
    
    console.log('Backend - Appointment created successfully:', {
      insertId: result.insertId,
      affectedRows: result.affectedRows
    });
    
    return res.status(201).json({ 
      message: 'Appointment created successfully',
      appointment_id: result.insertId
    });
  } catch (error) {
    console.error('Backend - Error creating appointment:', {
      message: error.message,
      code: error.code,
      errno: error.errno,
      sqlState: error.sqlState,
      sqlMessage: error.sqlMessage,
      sql: error.sql
    });
    
    // Handle specific database errors
    if (error.code === 'ER_TRUNCATED_WRONG_VALUE') {
      return res.status(400).json({ 
        message: 'Invalid time format provided. Please select a valid time slot.',
        error_code: 'INVALID_TIME_FORMAT',
        details: error.sqlMessage
      });
    }
    
    if (error.code === 'ER_DATA_TOO_LONG') {
      return res.status(400).json({ 
        message: 'One of the provided values is too long for the database field.',
        error_code: 'DATA_TOO_LONG',
        details: error.sqlMessage
      });
    }
    
    if (error.code === 'ER_BAD_NULL_ERROR') {
      return res.status(400).json({ 
        message: 'A required field is missing or null.',
        error_code: 'MISSING_REQUIRED_FIELD',
        details: error.sqlMessage
      });
    }
    
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ 
        message: 'This appointment conflicts with an existing booking.',
        error_code: 'DUPLICATE_APPOINTMENT',
        details: error.sqlMessage
      });
    }
    
    // Authentication/Authorization errors
    if (error.message && error.message.includes('authentication')) {
      return res.status(401).json({ 
        message: 'Authentication failed. Please log in again.',
        error_code: 'AUTH_FAILED'
      });
    }
    
    // Default server error with more context
    return res.status(500).json({ 
      message: 'Server error during appointment creation',
      error_code: 'SERVER_ERROR',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Update appointment status (cancel, reschedule)
app.put('/api/user/appointments/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, appointment_date, appointment_time } = req.body;
    
    // Verify the appointment belongs to the user
    const [appointmentCheck] = await pool.execute(
      'SELECT id FROM appointments WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );
    
    if (appointmentCheck.length === 0) {
      return res.status(404).json({ message: 'Appointment not found or not authorized' });
    }
    
    // Build the update query dynamically based on provided fields
    let updateQuery = 'UPDATE appointments SET ';
    const updateValues = [];
    
    if (status) {
      updateQuery += 'status = ?, ';
      updateValues.push(status);
    }
    
    if (appointment_date) {
      updateQuery += 'appointment_date = ?, ';
      updateValues.push(appointment_date);
    }
    
    if (appointment_time) {
      updateQuery += 'appointment_time = ?, ';
      updateValues.push(appointment_time);
    }
    
    // Remove trailing comma and space
    updateQuery = updateQuery.slice(0, -2);
    
    // Add WHERE clause
    updateQuery += ' WHERE id = ? AND user_id = ?';
    updateValues.push(id, req.user.id);
    
    // Execute the update
    await pool.execute(updateQuery, updateValues);
    
    return res.json({ message: 'Appointment updated successfully' });
  } catch (error) {
    console.error('Error updating appointment:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// User Addresses API

// Get all addresses for the user
app.get('/api/user/addresses', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM user_addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC',
      [req.user.id]
    );
    
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching addresses:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Add a new address
app.post('/api/user/addresses', authenticateToken, async (req, res) => {
  try {
    const { 
      address_type, 
      address_line1, 
      address_line2, 
      city, 
      state, 
      postal_code, 
      country, 
      is_default 
    } = req.body;
    
    // Validate input
    if (!address_type || !address_line1 || !city || !state || !postal_code) {
      return res.status(400).json({ message: 'All required fields must be provided' });
    }
    
    // If this is set as default, unset any existing default address
    if (is_default) {
      await pool.execute(
        'UPDATE user_addresses SET is_default = FALSE WHERE user_id = ?',
        [req.user.id]
      );
    }
    
    // Insert new address
    const [result] = await pool.execute(
      `INSERT INTO user_addresses 
       (user_id, address_type, address_line1, address_line2, city, state, postal_code, country, is_default) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id, 
        address_type, 
        address_line1, 
        address_line2 || null, 
        city, 
        state, 
        postal_code, 
        country || 'United States', 
        is_default || false
      ]
    );
    
    return res.status(201).json({ 
      message: 'Address added successfully',
      address_id: result.insertId
    });
  } catch (error) {
    console.error('Error adding address:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Update an address
app.put('/api/user/addresses/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      address_type, 
      address_line1, 
      address_line2, 
      city, 
      state, 
      postal_code, 
      country, 
      is_default 
    } = req.body;
    
    // Verify the address belongs to the user
    const [addressCheck] = await pool.execute(
      'SELECT id FROM user_addresses WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );
    
    if (addressCheck.length === 0) {
      return res.status(404).json({ message: 'Address not found or not authorized' });
    }
    
    // If this is set as default, unset any existing default address
    if (is_default) {
      await pool.execute(
        'UPDATE user_addresses SET is_default = FALSE WHERE user_id = ? AND id != ?',
        [req.user.id, id]
      );
    }
    
    // Build the update query dynamically based on provided fields
    let updateQuery = 'UPDATE user_addresses SET ';
    const updateValues = [];
    
    if (address_type) {
      updateQuery += 'address_type = ?, ';
      updateValues.push(address_type);
    }
    
    if (address_line1) {
      updateQuery += 'address_line1 = ?, ';
      updateValues.push(address_line1);
    }
    
    if (address_line2 !== undefined) {
      updateQuery += 'address_line2 = ?, ';
      updateValues.push(address_line2);
    }
    
    if (city) {
      updateQuery += 'city = ?, ';
      updateValues.push(city);
    }
    
    if (state) {
      updateQuery += 'state = ?, ';
      updateValues.push(state);
    }
    
    if (postal_code) {
      updateQuery += 'postal_code = ?, ';
      updateValues.push(postal_code);
    }
    
    if (country) {
      updateQuery += 'country = ?, ';
      updateValues.push(country);
    }
    
    if (is_default !== undefined) {
      updateQuery += 'is_default = ?, ';
      updateValues.push(is_default);
    }
    
    // Remove trailing comma and space
    updateQuery = updateQuery.slice(0, -2);
    
    // Add WHERE clause
    updateQuery += ' WHERE id = ? AND user_id = ?';
    updateValues.push(id, req.user.id);
    
    // Execute the update
    await pool.execute(updateQuery, updateValues);
    
    return res.json({ message: 'Address updated successfully' });
  } catch (error) {
    console.error('Error updating address:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Delete an address
app.delete('/api/user/addresses/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verify the address belongs to the user
    const [addressCheck] = await pool.execute(
      'SELECT id, is_default FROM user_addresses WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );
    
    if (addressCheck.length === 0) {
      return res.status(404).json({ message: 'Address not found or not authorized' });
    }
    
    // Delete the address
    await pool.execute(
      'DELETE FROM user_addresses WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );
    
    // If this was the default address, set another address as default if available
    if (addressCheck[0].is_default) {
      const [remainingAddresses] = await pool.execute(
        'SELECT id FROM user_addresses WHERE user_id = ? LIMIT 1',
        [req.user.id]
      );
      
      if (remainingAddresses.length > 0) {
        await pool.execute(
          'UPDATE user_addresses SET is_default = TRUE WHERE id = ?',
          [remainingAddresses[0].id]
        );
      }
    }
    
    return res.json({ message: 'Address deleted successfully' });
  } catch (error) {
    console.error('Error deleting address:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Support Tickets API

// Get all support tickets for the user
app.get('/api/user/support-tickets', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );
    
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching support tickets:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Create a new support ticket
app.post('/api/user/support-tickets', authenticateToken, async (req, res) => {
  try {
    const { subject, message } = req.body;
    
    // Validate input
    if (!subject || !message) {
      return res.status(400).json({ message: 'Subject and message are required' });
    }
    
    // Insert new support ticket
    const [result] = await pool.execute(
      'INSERT INTO support_tickets (user_id, subject, message) VALUES (?, ?, ?)',
      [req.user.id, subject, message]
    );
    
    return res.status(201).json({ 
      message: 'Support ticket created successfully',
      ticket_id: result.insertId
    });
  } catch (error) {
    console.error('Error creating support ticket:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Available Dates API

// Get all available dates (public endpoint)
app.get('/api/available-dates', async (req, res) => {
  try {
    const { categoryId } = req.query;
    
    let query = `
      SELECT 
        ad.id, 
        DATE_FORMAT(ad.date, "%Y-%m-%d") as date,
        DATE_FORMAT(ad.date, "%M %d, %Y") as formatted_date,
        DATE_FORMAT(ad.date, "%W") as day_name,
        DATE_FORMAT(ad.date, "%a") as day_short,
        DATE_FORMAT(ad.date, "%b") as month_short,
        DATE_FORMAT(ad.date, "%d") as day_number,
        DATE_FORMAT(ad.date, "%Y") as year,
        ad.is_available, 
        ad.max_appointments, 
        ad.created_at,
        sc.name as service_category_name,
        sc.slug as service_category_slug
      FROM available_dates ad
      LEFT JOIN service_categories sc ON ad.service_category_id = sc.id
      WHERE ad.is_available = TRUE AND ad.date >= CURDATE()
    `;
    
    const params = [];
    
    if (categoryId) {
      if (categoryId === 'null' || categoryId === '') {
        // Show only dates with no specific category (general dates)
        query += ' AND ad.service_category_id IS NULL';
      } else {
        // Show only dates for the specific category
        query += ' AND ad.service_category_id = ?';
        params.push(categoryId);
      }
    }
    
    query += ' ORDER BY ad.date ASC';
    
    const [rows] = await pool.execute(query, params);
    
    console.log('🔍 Public API - Available dates:', rows);
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching available dates:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get available time slots (public endpoint)
app.get('/api/available-time-slots', async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ message: 'Database not available' });
    }
    
    const { date, categoryId } = req.query;
    
    if (!date) {
      return res.status(400).json({ message: 'Date parameter is required' });
    }

    // Extract just the date part if datetime string is passed
    const dateOnly = date.includes('T') ? date.split('T')[0] : date;
    console.log('🔍 Public API - Time slots for date:', dateOnly, 'categoryId:', categoryId);

    let query = `SELECT id, start_time, end_time, is_available, extra_price, date, service_category_id
                 FROM available_time_slots 
                 WHERE date = ? AND is_available = 1`;
    let params = [dateOnly];
    
    // Category filtering logic
    if (categoryId) {
      if (categoryId === 'null' || categoryId === '') {
        // Show only time slots with no specific category (general time slots)
        query += ` AND service_category_id IS NULL`;
      } else {
        // Show only time slots for the specific category
        query += ` AND service_category_id = ?`;
        params.push(categoryId);
      }
    } else {
      // If no categoryId provided, show all time slots (backward compatibility)
      // This case handles when category filtering is not used
    }
    
    query += ` ORDER BY start_time ASC`;

    const [rows] = await pool.execute(query, params);

    console.log('🔍 Public API - Found time slots:', rows.length);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching available time slots:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Admin API for managing dates (requires admin role)
app.get('/api/admin/available-dates', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT 
        ad.id, 
        DATE_FORMAT(ad.date, "%Y-%m-%d") as date,
        DATE_FORMAT(ad.date, "%M %d, %Y") as formatted_date,
        DATE_FORMAT(ad.date, "%W") as day_name,
        DATE_FORMAT(ad.date, "%a") as day_short,
        DATE_FORMAT(ad.date, "%b") as month_short,
        DATE_FORMAT(ad.date, "%d") as day_number,
        DATE_FORMAT(ad.date, "%Y") as year,
        ad.is_available, 
        ad.max_appointments, 
        ad.created_at,
        ad.service_category_id,
        sc.name as service_category_name,
        sc.slug as service_category_slug
      FROM available_dates ad
      LEFT JOIN service_categories sc ON ad.service_category_id = sc.id
      ORDER BY ad.date ASC`
    );
    
    console.log('🔍 Raw rows from MySQL:', rows);
    
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching available dates:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Add new available date (admin only)
app.post('/api/admin/available-dates', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { date, is_available, max_appointments, service_category_id } = req.body;
    
    if (!date) {
      return res.status(400).json({ message: 'Date is required' });
    }
    
    const [result] = await pool.execute(
      'INSERT INTO available_dates (date, is_available, max_appointments, service_category_id, created_by) VALUES (?, ?, ?, ?, ?)',
      [date, is_available !== undefined ? is_available : true, max_appointments || 10, service_category_id || null, req.user.id]
    );
    
    return res.status(201).json({ 
      message: 'Available date added successfully',
      date_id: result.insertId
    });
  } catch (error) {
    console.error('Error adding available date:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: 'Date already exists' });
    }
    return res.status(500).json({ message: 'Server error' });
  }
});

// Update available date (admin only)
app.put('/api/admin/available-dates/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { date, is_available, max_appointments, service_category_id } = req.body;
    
    let updateQuery = 'UPDATE available_dates SET ';
    const updateValues = [];
    
    if (date) {
      updateQuery += 'date = ?, ';
      updateValues.push(date);
    }
    
    if (is_available !== undefined) {
      updateQuery += 'is_available = ?, ';
      updateValues.push(is_available);
    }
    
    if (max_appointments !== undefined) {
      updateQuery += 'max_appointments = ?, ';
      updateValues.push(max_appointments);
    }
    
    if (service_category_id !== undefined) {
      updateQuery += 'service_category_id = ?, ';
      updateValues.push(service_category_id);
    }
    
    // Remove trailing comma and space
    updateQuery = updateQuery.slice(0, -2);
    updateQuery += ' WHERE id = ?';
    updateValues.push(id);
    
    await pool.execute(updateQuery, updateValues);
    
    return res.json({ message: 'Available date updated successfully' });
  } catch (error) {
    console.error('Error updating available date:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Delete available date (admin only)
app.delete('/api/admin/available-dates/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    await pool.execute('DELETE FROM available_dates WHERE id = ?', [id]);
    
    return res.json({ message: 'Available date deleted successfully' });
  } catch (error) {
    console.error('Error deleting available date:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin API for managing time slots
app.get('/api/admin/available-time-slots', authenticateToken, isAdmin, async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ message: 'Database not available' });
    }
    
    const { date, categoryId } = req.query;
    let query = `
      SELECT ats.id, ats.start_time, ats.end_time, ats.is_available, ats.extra_price, 
             ats.created_at, ats.date, ats.service_category_id,
             sc.name as service_category_name, sc.slug as service_category_slug
      FROM available_time_slots ats
      LEFT JOIN service_categories sc ON ats.service_category_id = sc.id
    `;
    let params = [];
    
    if (date || categoryId) {
      query += ' WHERE ';
      let conditions = [];
      
      if (date) {
        conditions.push('DATE(ats.date) = ?');
        params.push(date);
      }
      
      if (categoryId) {
        conditions.push('(ats.service_category_id = ? OR ats.service_category_id IS NULL)');
        params.push(categoryId);
      }
      
      query += conditions.join(' AND ');
    }
    
    query += ' ORDER BY ats.date DESC, ats.start_time ASC';
    
    const [rows] = await pool.execute(query, params);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching time slots:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Add new time slot (admin only)
app.post('/api/admin/available-time-slots', authenticateToken, isAdmin, async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ message: 'Database not available' });
    }
    
    const { start_time, end_time, is_available, extra_price = 0, date, service_category_id } = req.body;
    
    // Validate required fields
    if (!start_time || !end_time || !date) {
      return res.status(400).json({ message: 'Start time, end time, and date are required' });
    }

    // Validate time format
    const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(start_time) || !timeRegex.test(end_time)) {
      return res.status(400).json({ message: 'Invalid time format. Use HH:MM format' });
    }

    // Validate that end time is after start time
    if (start_time >= end_time) {
      return res.status(400).json({ message: 'End time must be after start time' });
    }

    // Check for overlapping time slots on the same date and category
    const [overlapping] = await pool.execute(
      `SELECT id FROM available_time_slots 
       WHERE date = ? AND is_available = 1 
       AND (service_category_id = ? OR (service_category_id IS NULL AND ? IS NULL))
       AND (
         (start_time <= ? AND end_time > ?) OR
         (start_time < ? AND end_time >= ?) OR
         (start_time >= ? AND end_time <= ?)
       )`,
      [date, service_category_id, service_category_id, start_time, start_time, end_time, end_time, start_time, end_time]
    );

    if (overlapping.length > 0) {
      return res.status(400).json({ message: 'Time slot overlaps with existing available slot' });
    }

    // Insert new time slot
    const [result] = await pool.execute(
      'INSERT INTO available_time_slots (start_time, end_time, is_available, extra_price, date, service_category_id) VALUES (?, ?, ?, ?, ?, ?)',
      [start_time, end_time, is_available, extra_price, date, service_category_id]
    );

    res.status(201).json({
      id: result.insertId,
      start_time,
      end_time,
      is_available,
      extra_price,
      date,
      service_category_id,
      message: 'Time slot created successfully'
    });
  } catch (error) {
    console.error('Error creating time slot:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// PUT /api/admin/available-time-slots/:id - Update time slot (admin)
app.put('/api/admin/available-time-slots/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ message: 'Database not available' });
    }
    
    const { id } = req.params;
    const { start_time, end_time, is_available, extra_price, service_category_id } = req.body;

    // Check if time slot exists
    const [existing] = await pool.execute(
      'SELECT * FROM available_time_slots WHERE id = ?',
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: 'Time slot not found' });
    }

    const currentSlot = existing[0];
    
    // If updating time fields, validate them
    if (start_time || end_time) {
      const newStartTime = start_time || currentSlot.start_time;
      const newEndTime = end_time || currentSlot.end_time;
      
      // Validate time format
      const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
      if (!timeRegex.test(newStartTime) || !timeRegex.test(newEndTime)) {
        return res.status(400).json({ message: 'Invalid time format. Use HH:MM format' });
      }

      // Validate that end time is after start time
      if (newStartTime >= newEndTime) {
        return res.status(400).json({ message: 'End time must be after start time' });
      }

      // Check for overlapping time slots on the same date (excluding current slot)
      const [overlapping] = await pool.execute(
        `SELECT id FROM available_time_slots 
         WHERE id != ? AND date = ? AND is_available = 1 
         AND (
           (start_time <= ? AND end_time > ?) OR
           (start_time < ? AND end_time >= ?) OR
           (start_time >= ? AND end_time <= ?)
         )`,
        [id, currentSlot.date, newStartTime, newStartTime, newEndTime, newEndTime, newStartTime, newEndTime]
    );

      if (overlapping.length > 0) {
        return res.status(400).json({ message: 'Time slot overlaps with existing available slot' });
      }
    }

    // Update the time slot
    const [result] = await pool.execute(
      `UPDATE available_time_slots 
       SET start_time = COALESCE(?, start_time),
           end_time = COALESCE(?, end_time),
           is_available = COALESCE(?, is_available),
           extra_price = COALESCE(?, extra_price),
           service_category_id = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [start_time, end_time, is_available, extra_price, service_category_id, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Time slot not found' });
    }

    // Fetch updated time slot
    const [updated] = await pool.execute(
      'SELECT * FROM available_time_slots WHERE id = ?',
      [id]
    );

    res.json({
      message: 'Time slot updated successfully',
      timeSlot: updated[0]
    });
  } catch (error) {
    console.error('Error updating time slot:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Delete time slot (admin only)
app.delete('/api/admin/available-time-slots/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    await pool.execute('DELETE FROM available_time_slots WHERE id = ?', [id]);
    
    return res.json({ message: 'Time slot deleted successfully' });
  } catch (error) {
    console.error('Error deleting time slot:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin API for managing appointments
app.get('/api/admin/appointments', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT 
        a.id, a.user_id, a.service, a.appointment_date, a.appointment_time, a.status,
        a.location, a.price, a.notes, a.room_type, a.room_type_slug, a.property_type, a.property_type_slug, 
        a.quantity, a.service_category, a.service_category_slug, a.extra_price, a.cod_fee, a.payment_method,
        a.created_at, a.updated_at,
        u.fullName as customer_name, u.phone as customer_phone 
      FROM appointments a 
      LEFT JOIN users u ON a.user_id = u.id 
      ORDER BY a.appointment_date DESC, a.appointment_time DESC
    `);
    
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching appointments:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Update appointment status (admin only)
app.put('/api/admin/appointments/:id/status', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    if (!status) {
      return res.status(400).json({ message: 'Status is required' });
    }
    
    const validStatuses = ['pending', 'confirmed', 'in-progress', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    
    await pool.execute('UPDATE appointments SET status = ? WHERE id = ?', [status, id]);
    
    return res.json({ message: 'Appointment status updated successfully' });
  } catch (error) {
    console.error('Error updating appointment status:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get all users/customers (admin only)
app.get('/api/admin/users', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT 
        id, 
        fullName, 
        email, 
        phone, 
        address, 
        role, 
        created_at,
        (SELECT COUNT(*) FROM appointments WHERE user_id = users.id) as total_appointments,
        (SELECT COALESCE(SUM(price), 0) FROM appointments WHERE user_id = users.id AND status = 'completed') as total_spent
      FROM users 
      ORDER BY created_at DESC
    `);
    
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching users:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Update user (admin only)
app.put('/api/admin/users/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { fullName, email, phone, role, status } = req.body;
    
    // Build dynamic update query
    let updateQuery = 'UPDATE users SET ';
    const updateValues = [];
    
    if (fullName) {
      updateQuery += 'fullName = ?, ';
      updateValues.push(fullName);
    }
    
    if (email) {
      updateQuery += 'email = ?, ';
      updateValues.push(email);
    }
    
    if (phone) {
      updateQuery += 'phone = ?, ';
      updateValues.push(phone);
    }
    
    if (role) {
      updateQuery += 'role = ?, ';
      updateValues.push(role);
    }
    
    // Remove trailing comma and space
    updateQuery = updateQuery.slice(0, -2);
    updateQuery += ' WHERE id = ?';
    updateValues.push(id);
    
    await pool.execute(updateQuery, updateValues);
    
    return res.json({ message: 'User updated successfully' });
  } catch (error) {
    console.error('Error updating user:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Delete user (admin only)
app.delete('/api/admin/users/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if user has appointments
    const [appointments] = await pool.execute('SELECT COUNT(*) as count FROM appointments WHERE user_id = ?', [id]);
    
    if (appointments[0].count > 0) {
      return res.status(400).json({ 
        message: 'Cannot delete user with existing appointments. Please cancel or complete appointments first.' 
      });
    }
    
    await pool.execute('DELETE FROM users WHERE id = ?', [id]);
    
    return res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get user profile
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const [rows] = await pool.execute(`
      SELECT id, fullName, email, phone, address, role, created_at 
      FROM users 
      WHERE id = ?
    `, [userId]);
    
    if (rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    return res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching user profile:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Update user profile
app.put('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { fullName, email, address } = req.body;
    
    // Validate required fields
    if (!fullName || !fullName.trim()) {
      return res.status(400).json({ message: 'Full name is required' });
    }
    
    // Validate email if provided
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: 'Invalid email format' });
    }
    
    // Check if email already exists for another user
    if (email) {
      const [existingUsers] = await pool.execute(
        'SELECT id FROM users WHERE email = ? AND id != ?',
        [email, userId]
      );
      
      if (existingUsers.length > 0) {
        return res.status(400).json({ message: 'Email already exists' });
      }
    }
    
    // Update user profile
    await pool.execute(`
      UPDATE users 
      SET fullName = ?, email = ?, address = ?
      WHERE id = ?
    `, [fullName.trim(), email || null, address || null, userId]);
    
    return res.json({ message: 'Profile updated successfully' });
  } catch (error) {
    console.error('Error updating user profile:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Change user password
app.put('/api/user/change-password', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.body;
    
    // Validate required fields
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current password and new password are required' });
    }
    
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters long' });
    }
    
    // Get user's current password
    const [userRows] = await pool.execute(
      'SELECT password FROM users WHERE id = ?',
      [userId]
    );
    
    if (userRows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    const user = userRows[0];
    
    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isCurrentPasswordValid) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }
    
    // Hash new password
    const saltRounds = 10;
    const hashedNewPassword = await bcrypt.hash(newPassword, saltRounds);
    
    // Update password
    await pool.execute(
      'UPDATE users SET password = ? WHERE id = ?',
      [hashedNewPassword, userId]
    );
    
    return res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Error changing password:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get user addresses
app.get('/api/user/addresses', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const [rows] = await pool.execute(`
      SELECT * FROM user_address 
      WHERE user_id = ? 
      ORDER BY is_default DESC, created_at DESC
    `, [userId]);
    
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching user addresses:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Add new user address
app.post('/api/user/addresses', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { address_type, address_line1, address_line2, city, state, postal_code, country, is_default } = req.body;
    
    // Validate required fields
    if (!address_type || !address_line1 || !city || !state || !postal_code || !country) {
      return res.status(400).json({ message: 'All required fields must be provided' });
    }
    
    // If setting as default, remove default from other addresses
    if (is_default) {
      await pool.execute(
        'UPDATE user_address SET is_default = FALSE WHERE user_id = ?',
        [userId]
      );
    }
    
    // Insert new address
    const [result] = await pool.execute(`
      INSERT INTO user_address (user_id, address_type, address_line1, address_line2, city, state, postal_code, country, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `, [userId, address_type, address_line1, address_line2 || null, city, state, postal_code, country, is_default || false]);
    
    return res.json({ message: 'Address added successfully', id: result.insertId });
  } catch (error) {
    console.error('Error adding user address:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Update user address
app.put('/api/user/addresses/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const addressId = req.params.id;
    const { address_type, address_line1, address_line2, city, state, postal_code, country, is_default } = req.body;
    
    // Validate required fields
    if (!address_type || !address_line1 || !city || !state || !postal_code || !country) {
      return res.status(400).json({ message: 'All required fields must be provided' });
    }
    
    // Check if address belongs to user
    const [existingAddress] = await pool.execute(
      'SELECT id FROM user_address WHERE id = ? AND user_id = ?',
      [addressId, userId]
    );
    
    if (existingAddress.length === 0) {
      return res.status(404).json({ message: 'Address not found' });
    }
    
    // If setting as default, remove default from other addresses
    if (is_default) {
      await pool.execute(
        'UPDATE user_address SET is_default = FALSE WHERE user_id = ? AND id != ?',
        [userId, addressId]
      );
    }
    
    // Update address
    await pool.execute(`
      UPDATE user_address 
      SET address_type = ?, address_line1 = ?, address_line2 = ?, city = ?, state = ?, postal_code = ?, country = ?, is_default = ?, updated_at = NOW()
      WHERE id = ? AND user_id = ?
    `, [address_type, address_line1, address_line2 || null, city, state, postal_code, country, is_default || false, addressId, userId]);
    
    return res.json({ message: 'Address updated successfully' });
  } catch (error) {
    console.error('Error updating user address:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Delete user address
app.delete('/api/user/addresses/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const addressId = req.params.id;
    
    // Check if address belongs to user
    const [existingAddress] = await pool.execute(
      'SELECT id FROM user_address WHERE id = ? AND user_id = ?',
      [addressId, userId]
    );
    
    if (existingAddress.length === 0) {
      return res.status(404).json({ message: 'Address not found' });
    }
    
    // Delete address
    await pool.execute(
      'DELETE FROM user_address WHERE id = ? AND user_id = ?',
      [addressId, userId]
    );
    
    return res.json({ message: 'Address deleted successfully' });
  } catch (error) {
    console.error('Error deleting user address:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Support Tickets API

// Get user's support tickets
app.get('/api/user/support-tickets', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const [tickets] = await pool.execute(
      'SELECT id, user_id, subject, message, status, created_at, updated_at FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    
    return res.json(tickets);
  } catch (error) {
    console.error('Error fetching support tickets:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Create new support ticket
app.post('/api/user/support-tickets', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { subject, message } = req.body;
    
    // Validate required fields
    if (!subject || !message) {
      return res.status(400).json({ message: 'Subject and message are required' });
    }
    
    // Insert new support ticket
    const [result] = await pool.execute(`
      INSERT INTO support_tickets (user_id, subject, message, status, created_at, updated_at)
      VALUES (?, ?, ?, 'open', NOW(), NOW())
    `, [userId, subject.trim(), message.trim()]);
    
    return res.status(201).json({ 
      message: 'Support ticket created successfully', 
      ticket_id: result.insertId 
    });
  } catch (error) {
    console.error('Error creating support ticket:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get single support ticket (for user)
app.get('/api/user/support-tickets/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const ticketId = req.params.id;
    
    const [tickets] = await pool.execute(
      'SELECT id, user_id, subject, message, status, created_at, updated_at FROM support_tickets WHERE id = ? AND user_id = ?',
      [ticketId, userId]
    );
    
    if (tickets.length === 0) {
      return res.status(404).json({ message: 'Support ticket not found' });
    }
    
    return res.json(tickets[0]);
  } catch (error) {
    console.error('Error fetching support ticket:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin Support Ticket Endpoints

// Get all support tickets (for admin)
app.get('/api/admin/support-tickets', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [tickets] = await pool.execute(`
      SELECT 
        st.id, 
        st.user_id, 
        st.subject, 
        st.message, 
        st.status, 
        st.priority,
        st.admin_response,
        st.admin_id,
        st.created_at, 
        st.updated_at,
        u.fullName as user_name,
        u.email as user_email
      FROM support_tickets st
      LEFT JOIN users u ON st.user_id = u.id
      ORDER BY 
        CASE st.status 
          WHEN 'open' THEN 1 
          WHEN 'in_progress' THEN 2 
          WHEN 'resolved' THEN 3 
          WHEN 'closed' THEN 4 
        END,
        CASE st.priority 
          WHEN 'high' THEN 1 
          WHEN 'medium' THEN 2 
          WHEN 'low' THEN 3 
        END,
        st.created_at DESC
    `);
    
    return res.json(tickets);
  } catch (error) {
    console.error('Error fetching support tickets for admin:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Update support ticket status (for admin)
app.put('/api/admin/support-tickets/:id/status', authenticateToken, isAdmin, async (req, res) => {
  try {
    const ticketId = req.params.id;
    const { status } = req.body;
    
    // Validate status
    const validStatuses = ['open', 'in_progress', 'resolved', 'closed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    
    const [result] = await pool.execute(
      'UPDATE support_tickets SET status = ?, updated_at = NOW() WHERE id = ?',
      [status, ticketId]
    );
    
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Support ticket not found' });
    }
    
    return res.json({ success: true, message: 'Ticket status updated successfully' });
  } catch (error) {
    console.error('Error updating support ticket status:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Add admin response to support ticket
app.put('/api/admin/support-tickets/:id/response', authenticateToken, isAdmin, async (req, res) => {
  try {
    const ticketId = req.params.id;
    const adminId = req.user.id;
    const { admin_response } = req.body;
    
    // Validate admin response
    if (!admin_response || admin_response.trim().length === 0) {
      return res.status(400).json({ message: 'Admin response is required' });
    }
    
    const [result] = await pool.execute(
      'UPDATE support_tickets SET admin_response = ?, admin_id = ?, updated_at = NOW() WHERE id = ?',
      [admin_response.trim(), adminId, ticketId]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Support ticket not found' });
    }
    
    return res.json({ success: true, message: 'Admin response added successfully' });
  } catch (error) {
    console.error('Error adding admin response:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Update support ticket priority (for admin)
app.put('/api/admin/support-tickets/:id/priority', authenticateToken, isAdmin, async (req, res) => {
  try {
    const ticketId = req.params.id;
    const { priority } = req.body;
    
    // Validate priority
    const validPriorities = ['low', 'medium', 'high'];
    if (!validPriorities.includes(priority)) {
      return res.status(400).json({ message: 'Invalid priority' });
    }
    
    const [result] = await pool.execute(
      'UPDATE support_tickets SET priority = ?, updated_at = NOW() WHERE id = ?',
      [priority, ticketId]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Support ticket not found' });
    }
    
    return res.json({ success: true, message: 'Ticket priority updated successfully' });
  } catch (error) {
    console.error('Error updating support ticket priority:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get support ticket statistics (for admin)
app.get('/api/admin/support-tickets/stats', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [stats] = await pool.execute(`
      SELECT 
        COUNT(*) as total_tickets,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_tickets,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress_tickets,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved_tickets,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_tickets,
        SUM(CASE WHEN priority = 'high' THEN 1 ELSE 0 END) as high_priority_tickets,
        SUM(CASE WHEN priority = 'medium' THEN 1 ELSE 0 END) as medium_priority_tickets,
        SUM(CASE WHEN priority = 'low' THEN 1 ELSE 0 END) as low_priority_tickets
      FROM support_tickets
    `);
    
    return res.json(stats[0]);
  } catch (error) {
    console.error('Error fetching support ticket statistics:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Super Admin API Endpoints

// Get system statistics (for super admin)
app.get('/api/superadmin/system-stats', authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    // Get total users count
    const [userStats] = await pool.execute('SELECT COUNT(*) as total_users FROM users');
    
    // Get total appointments count
    const [appointmentStats] = await pool.execute('SELECT COUNT(*) as total_appointments FROM appointments');
    
    // Get active admins count
    const [adminStats] = await pool.execute("SELECT COUNT(*) as active_admins FROM users WHERE role IN ('admin', 'super_admin')");
    
    // Get API configurations status
    const [apiConfigs] = await pool.execute('SELECT service_name, status FROM api_configurations');
    
    const apiStatuses = {
      google_maps: 'inactive',
      twilio: 'inactive'
    };
    
    apiConfigs.forEach(config => {
      apiStatuses[config.service_name] = config.status;
    });
    
    // Calculate system health based on API statuses
    let systemHealth = 'healthy';
    if (apiStatuses.google_maps === 'inactive' || apiStatuses.twilio === 'inactive') {
      systemHealth = 'warning';
    }
    
    const stats = {
      totalUsers: userStats[0].total_users,
      totalAppointments: appointmentStats[0].total_appointments,
      activeAdmins: adminStats[0].active_admins,
      systemHealth,
      apiStatuses,
      databaseSize: '250 MB', // This would need actual calculation
      lastBackup: new Date().toISOString() // This would come from backup logs
    };
    
    return res.json(stats);
  } catch (error) {
    console.error('Error fetching system stats:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get API configurations (for super admin)
app.get('/api/superadmin/api-configs', authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    const [configs] = await pool.execute(`
      SELECT id, service_name, api_key, additional_config, status, last_tested, created_at, updated_at
      FROM api_configurations
      ORDER BY service_name
    `);
    
    return res.json(configs);
  } catch (error) {
    console.error('Error fetching API configurations:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Save/Update API configuration (for super admin)
app.post('/api/superadmin/api-configs', authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    const { service_name, api_key, additional_config } = req.body;
    
    if (!service_name || !api_key) {
      return res.status(400).json({ message: 'Service name and API key are required' });
    }
    
    // Check if configuration exists
    const [existing] = await pool.execute(
      'SELECT id FROM api_configurations WHERE service_name = ?',
      [service_name]
    );
    
    if (existing.length > 0) {
      // Update existing configuration
      await pool.execute(
        'UPDATE api_configurations SET api_key = ?, additional_config = ?, updated_at = NOW() WHERE service_name = ?',
        [api_key, JSON.stringify(additional_config || {}), service_name]
      );
    } else {
      // Insert new configuration
      await pool.execute(
        'INSERT INTO api_configurations (service_name, api_key, additional_config) VALUES (?, ?, ?)',
        [service_name, api_key, JSON.stringify(additional_config || {})]
      );
    }
    
    // Clear API config cache so new configuration takes effect immediately
    clearApiConfigCache();
    
    return res.json({ success: true, message: 'API configuration saved successfully' });
  } catch (error) {
    console.error('Error saving API configuration:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get dynamic API key for frontend use
app.get('/api/config/:service', async (req, res) => {
  try {
    const serviceName = req.params.service;
    
    const [configs] = await pool.execute(
      'SELECT api_key FROM api_configurations WHERE service_name = ? AND status = "active"',
      [serviceName]
    );
    
    if (configs.length === 0) {
      return res.status(404).json({ message: 'API configuration not found or inactive' });
    }
    
    // Only return the API key for Google Maps (frontend use)
    if (serviceName === 'google_maps') {
      return res.json({ api_key: configs[0].api_key });
    }
    
    // For other services, don't expose the key to frontend
    return res.status(403).json({ message: 'API key not available for this service' });
  } catch (error) {
    console.error('Error fetching API configuration:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get all users (for super admin user management)
app.get('/api/superadmin/users', authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    const [users] = await pool.execute(`
      SELECT 
        u.id, u.phone, u.fullName, u.email, u.role, u.created_at as createdAt, u.updated_at,
        u.address,
        (SELECT COUNT(*) FROM appointments WHERE user_id = u.id) as appointmentsCount
      FROM users u
      ORDER BY u.created_at DESC
    `);
    
    // Format the response to match the frontend interface
    const formattedUsers = users.map(user => {
      let address = {};
      try {
        address = typeof user.address === 'string' ? JSON.parse(user.address) : user.address;
      } catch (e) {
        address = {};
      }
      
      return {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: 'active', // Default status since column doesn't exist
        createdAt: user.createdAt,
        lastLogin: null, // Column doesn't exist yet
        appointmentsCount: user.appointmentsCount,
        address: {
          city: address.city || '',
          country: address.country || ''
        }
      };
    });
    
    return res.json({ users: formattedUsers });
  } catch (error) {
    console.error('Error fetching users:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Super admin impersonation endpoint
app.post('/api/superadmin/impersonate', authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    const { targetUserId, originalUserId } = req.body;
    
    if (!targetUserId) {
      return res.status(400).json({ message: 'Target user ID is required' });
    }
    
    // Get target user information
    const [targetUser] = await pool.execute(
      'SELECT id, phone, fullName, email, role FROM users WHERE id = ?',
      [targetUserId]
    );
    
    if (targetUser.length === 0) {
      return res.status(404).json({ message: 'Target user not found' });
    }
    
    const user = targetUser[0];
    
    // Prevent impersonating another super admin
    if (user.role === 'super_admin') {
      return res.status(403).json({ message: 'Cannot impersonate another super admin' });
    }
    
    // Create a special impersonation token that includes original user info
    const impersonationToken = jwt.sign(
      { 
        id: user.id, 
        phone: user.phone, 
        role: user.role,
        isImpersonating: true,
        originalUserId: originalUserId,
        originalRole: 'super_admin'
      },
      JWT_SECRET,
      { expiresIn: '2h' } // Limited time for impersonation
    );
    
    // Note: lastLogin column doesn't exist in current schema
    // await pool.execute(
    //   'UPDATE users SET lastLogin = NOW() WHERE id = ?',
    //   [targetUserId]
    // );
    
    return res.json({
      token: impersonationToken,
      user: {
        id: user.id,
        phone: user.phone,
        fullName: user.fullName,
        email: user.email,
        role: user.role
      },
      impersonating: true,
      originalUserId: originalUserId
    });
  } catch (error) {
    console.error('Error during impersonation:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Create new admin/manager user (for super admin)
app.post('/api/superadmin/create-user', authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    const { fullName, email, phone, password, role } = req.body;
    
    if (!fullName || !email || !phone || !password || !role) {
      return res.status(400).json({ message: 'All fields are required' });
    }
    
    // Validate role - only admin and manager allowed
    if (!['admin', 'manager'].includes(role)) {
      return res.status(400).json({ message: 'Invalid role. Only admin and manager are allowed.' });
    }
    
    // Check if user already exists
    const [existingUser] = await pool.execute(
      'SELECT id FROM users WHERE email = ? OR phone = ?',
      [email, phone]
    );
    
    if (existingUser.length > 0) {
      return res.status(400).json({ message: 'User with this email or phone already exists' });
    }
    
    // Hash the password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    
    // Create default address structure
    const defaultAddress = {
      recipientName: fullName,
      buildingInfo: '',
      streetInfo: '',
      locality: '',
      city: '',
      country: ''
    };
    
    // Insert new user
    const [result] = await pool.execute(
      'INSERT INTO users (phone, fullName, email, address, password, role) VALUES (?, ?, ?, ?, ?, ?)',
      [phone, fullName, email, JSON.stringify(defaultAddress), hashedPassword, role]
    );
    
    return res.status(201).json({
      success: true,
      message: `${role.charAt(0).toUpperCase() + role.slice(1)} user created successfully`,
      user: {
        id: result.insertId,
        fullName,
        email,
        phone,
        role
      }
    });
  } catch (error) {
    console.error('Error creating user:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: 'User with this email or phone already exists' });
    }
    return res.status(500).json({ message: 'Server error' });
  }
});

// Exit impersonation endpoint
app.post('/api/superadmin/exit-impersonation', authenticateToken, async (req, res) => {
  try {
    const { originalUserId } = req.body;
    
    if (!req.user.isImpersonating || !originalUserId) {
      return res.status(400).json({ message: 'Not currently impersonating or missing original user ID' });
    }
    
    // Get original super admin user information
    const [originalUser] = await pool.execute(
      'SELECT id, phone, fullName, email, role FROM users WHERE id = ? AND role = "super_admin"',
      [originalUserId]
    );
    
    if (originalUser.length === 0) {
      return res.status(404).json({ message: 'Original user not found or not a super admin' });
    }
    
    const user = originalUser[0];
    
    // Create a new regular token for the super admin
    const token = jwt.sign(
      { id: user.id, phone: user.phone, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    return res.json({
      token: token,
      user: {
        id: user.id,
        phone: user.phone,
        fullName: user.fullName,
        email: user.email,
        role: user.role
      },
      impersonating: false
    });
  } catch (error) {
    console.error('Error exiting impersonation:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get super admin profile
app.get('/api/superadmin/profile', authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    const [user] = await pool.execute(
      'SELECT id, phone, fullName, email, role, address, created_at as createdAt FROM users WHERE id = ?',
      [req.user.id]
    );
    
    if (user.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    const userData = user[0];
    let address = {};
    
    try {
      address = typeof userData.address === 'string' ? JSON.parse(userData.address) : userData.address;
    } catch (e) {
      address = {
        recipientName: '',
        buildingInfo: '',
        streetInfo: '',
        locality: '',
        city: '',
        country: ''
      };
    }
    
    return res.json({
      profile: {
        id: userData.id,
        fullName: userData.fullName,
        email: userData.email,
        phone: userData.phone,
        role: userData.role,
        createdAt: userData.createdAt,
        address: address
      }
    });
  } catch (error) {
    console.error('Error fetching profile:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Update super admin personal information
app.put('/api/superadmin/profile/personal', authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    const { fullName, email, phone } = req.body;
    
    if (!fullName || !email || !phone) {
      return res.status(400).json({ message: 'All fields are required' });
    }
    
    // Check if email or phone is already taken by another user
    const [existingUser] = await pool.execute(
      'SELECT id FROM users WHERE (email = ? OR phone = ?) AND id != ?',
      [email, phone, req.user.id]
    );
    
    if (existingUser.length > 0) {
      return res.status(400).json({ message: 'Email or phone number is already in use by another user' });
    }
    
    // Update user information
    await pool.execute(
      'UPDATE users SET fullName = ?, email = ?, phone = ?, updated_at = NOW() WHERE id = ?',
      [fullName, email, phone, req.user.id]
    );
    
    return res.json({ success: true, message: 'Personal information updated successfully' });
  } catch (error) {
    console.error('Error updating personal info:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: 'Email or phone number is already in use' });
    }
    return res.status(500).json({ message: 'Server error' });
  }
});

// Update super admin address
app.put('/api/superadmin/profile/address', authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    const { recipientName, buildingInfo, streetInfo, locality, city, country } = req.body;
    
    const addressData = {
      recipientName: recipientName || '',
      buildingInfo: buildingInfo || '',
      streetInfo: streetInfo || '',
      locality: locality || '',
      city: city || '',
      country: country || ''
    };
    
    // Update address
    await pool.execute(
      'UPDATE users SET address = ?, updated_at = NOW() WHERE id = ?',
      [JSON.stringify(addressData), req.user.id]
    );
    
    return res.json({ success: true, message: 'Address updated successfully' });
  } catch (error) {
    console.error('Error updating address:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Change super admin password
app.put('/api/superadmin/profile/password', authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current password and new password are required' });
    }
    
    // Get current user with password
    const [user] = await pool.execute(
      'SELECT password FROM users WHERE id = ?',
      [req.user.id]
    );
    
    if (user.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user[0].password);
    if (!isCurrentPasswordValid) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }
    
    // Hash new password
    const saltRounds = 10;
    const hashedNewPassword = await bcrypt.hash(newPassword, saltRounds);
    
    // Update password
    await pool.execute(
      'UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?',
      [hashedNewPassword, req.user.id]
    );
    
    return res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Error changing super admin password:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin Profile Management Endpoints

// Get admin profile
app.get('/api/admin/profile', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [user] = await pool.execute(
      'SELECT id, phone, fullName, email, role, address, created_at as createdAt FROM users WHERE id = ?',
      [req.user.id]
    );
    
    if (user.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    const userData = user[0];
    let address = {};
    
    try {
      address = typeof userData.address === 'string' ? JSON.parse(userData.address) : userData.address;
    } catch (e) {
      address = {
        recipientName: '',
        buildingInfo: '',
        streetInfo: '',
        locality: '',
        city: '',
        country: ''
      };
    }
    
    return res.json({
      profile: {
        id: userData.id,
        fullName: userData.fullName,
        email: userData.email,
        phone: userData.phone,
        role: userData.role,
        createdAt: userData.createdAt,
        address: address
      }
    });
  } catch (error) {
    console.error('Error fetching admin profile:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Update admin personal information
app.put('/api/admin/profile/personal', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { fullName, email, phone } = req.body;
    
    if (!fullName || !email || !phone) {
      return res.status(400).json({ message: 'All fields are required' });
    }
    
    // Check if email or phone is already taken by another user
    const [existingUser] = await pool.execute(
      'SELECT id FROM users WHERE (email = ? OR phone = ?) AND id != ?',
      [email, phone, req.user.id]
    );
    
    if (existingUser.length > 0) {
      return res.status(400).json({ message: 'Email or phone number is already in use by another user' });
    }
    
    // Update user information
    await pool.execute(
      'UPDATE users SET fullName = ?, email = ?, phone = ?, updated_at = NOW() WHERE id = ?',
      [fullName, email, phone, req.user.id]
    );
    
    return res.json({ success: true, message: 'Personal information updated successfully' });
  } catch (error) {
    console.error('Error updating admin personal info:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: 'Email or phone number is already in use' });
    }
    return res.status(500).json({ message: 'Server error' });
  }
});

// Update admin address
app.put('/api/admin/profile/address', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { recipientName, buildingInfo, streetInfo, locality, city, country } = req.body;
    
    const addressData = {
      recipientName: recipientName || '',
      buildingInfo: buildingInfo || '',
      streetInfo: streetInfo || '',
      locality: locality || '',
      city: city || '',
      country: country || ''
    };
    
    // Update address
    await pool.execute(
      'UPDATE users SET address = ?, updated_at = NOW() WHERE id = ?',
      [JSON.stringify(addressData), req.user.id]
    );
    
    return res.json({ success: true, message: 'Address updated successfully' });
  } catch (error) {
    console.error('Error updating admin address:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Change admin password
app.put('/api/admin/profile/password', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current password and new password are required' });
    }
    
    // Get current user with password
    const [user] = await pool.execute(
      'SELECT password FROM users WHERE id = ?',
      [req.user.id]
    );
    
    if (user.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user[0].password);
    if (!isCurrentPasswordValid) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }
    
    // Hash new password
    const saltRounds = 10;
    const hashedNewPassword = await bcrypt.hash(newPassword, saltRounds);
    
    // Update password
    await pool.execute(
      'UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?',
      [hashedNewPassword, req.user.id]
    );
    
    return res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Error changing admin password:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ===== SERVICE MANAGEMENT API ENDPOINTS =====

// Test endpoint to verify appointments table structure
app.get('/api/test/appointments-table', async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ message: 'Database not available' });
    }
    
    // Check if table exists and get structure
    const [columns] = await pool.execute(`
      SHOW COLUMNS FROM appointments
    `);
    
    // Get sample data to verify new columns
    const [sampleData] = await pool.execute(`
      SELECT id, service, room_type, property_type, quantity, service_category 
      FROM appointments 
      LIMIT 1
    `);
    
    res.json({ 
      message: 'Appointments table structure verified',
      columns: columns.map(col => ({ name: col.Field, type: col.Type, default: col.Default })),
      sampleData: sampleData[0] || 'No appointments found'
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Table check failed',
      details: error.message 
    });
  }
});

// Get service items for a specific category (public endpoint)
app.get('/api/service-items/:categorySlug', async (req, res) => {
  try {
    const { categorySlug } = req.params;
    
    const [rows] = await pool.execute(`
      SELECT si.*, sc.name as category_name, sc.slug as category_slug
      FROM service_items si
      LEFT JOIN service_categories sc ON si.category_id = sc.id
      WHERE sc.slug = ? AND si.is_active = TRUE AND sc.is_active = TRUE
      ORDER BY si.sort_order ASC, si.name ASC
    `, [categorySlug]);
    
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching service items:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get single service item by slug (public endpoint)
app.get('/api/service-item/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    
    const [rows] = await pool.execute(`
      SELECT si.*, sc.name as category_name, sc.slug as category_slug
      FROM service_items si
      LEFT JOIN service_categories sc ON si.category_id = sc.id
      WHERE si.slug = ? AND si.is_active = TRUE AND sc.is_active = TRUE
    `, [slug]);
    
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Service item not found' });
    }
    
    return res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching service item:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get filtered service pricing for a specific service item (public endpoint)
app.get('/api/service-pricing-filtered/:serviceSlug', async (req, res) => {
  try {
    const { serviceSlug } = req.params;
    
    // First get the service item to find its category
    const [serviceItem] = await pool.execute(`
      SELECT si.*, sc.id as category_id, sc.slug as category_slug
      FROM service_items si
      LEFT JOIN service_categories sc ON si.category_id = sc.id
      WHERE si.slug = ? AND si.is_active = TRUE
    `, [serviceSlug]);
    
    if (serviceItem.length === 0) {
      return res.status(404).json({ message: 'Service item not found' });
    }
    
    const item = serviceItem[0];
    
    // Now get pricing for this service's category
    const [rows] = await pool.execute(`
      SELECT 
        sp.*,
        sc.name as category_name,
        sc.slug as category_slug,
        pt.name as property_type_name,
        pt.slug as property_type_slug,
        rt.name as room_type_name,
        rt.slug as room_type_slug,
        rt.image_url as room_image,
        rt.description as room_description,
        rt.whats_included as whats_included
      FROM service_pricing sp
      LEFT JOIN service_categories sc ON sp.service_category_id = sc.id
      LEFT JOIN property_types pt ON sp.property_type_id = pt.id
      LEFT JOIN room_types rt ON sp.room_type_id = rt.id
      WHERE sp.service_category_id = ? AND sp.is_active = TRUE
      ORDER BY pt.sort_order ASC, rt.sort_order ASC
    `, [item.category_id]);
    
    return res.json({
      serviceItem: item,
      pricing: rows
    });
  } catch (error) {
    console.error('Error fetching filtered service pricing:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get all service categories (public endpoint)
app.get('/api/service-categories', async (req, res) => {
  try {
    const [categories] = await pool.execute(
      'SELECT * FROM service_categories WHERE is_active = TRUE ORDER BY sort_order ASC, name ASC'
    );
    
    return res.json(categories);
  } catch (error) {
    console.error('Error fetching service categories:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get all service items (public endpoint)
app.get('/api/service-items', async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT si.*, sc.name as category_name, sc.slug as category_slug
      FROM service_items si
      LEFT JOIN service_categories sc ON si.category_id = sc.id
      WHERE si.is_active = TRUE AND (sc.is_active IS NULL OR sc.is_active = TRUE)
      ORDER BY si.sort_order ASC, si.name ASC
    `);

    return res.json(rows);
  } catch (error) {
    console.error('Error fetching service items:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get service items by category (admin endpoint)
app.get('/api/admin/service-items/by-category/:categoryId', async (req, res) => {
  try {
    const { categoryId } = req.params;
    const [rows] = await pool.execute(`
      SELECT si.*, sc.name as category_name, sc.slug as category_slug
      FROM service_items si
      LEFT JOIN service_categories sc ON si.category_id = sc.id
      WHERE si.category_id = ? AND si.is_active = TRUE
      ORDER BY si.sort_order ASC, si.name ASC
    `, [categoryId]);

    return res.json(rows);
  } catch (error) {
    console.error('Error fetching service items by category:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin API endpoints for service items management
app.get('/api/admin/service-items', async (req, res) => {
  try {
    const query = `
      SELECT si.*, sc.name as category_name 
      FROM service_items si
      LEFT JOIN service_categories sc ON si.category_id = sc.id
      ORDER BY si.sort_order, si.name
    `;
    const [results] = await pool.execute(query);
    res.json(results);
  } catch (error) {
    console.error('Error fetching admin service items:', error);
    res.status(500).json({ error: 'Failed to fetch service items' });
  }
});

app.post('/api/admin/service-items', async (req, res) => {
  try {
    const { name, slug, category_id, description, image_url, rating_text, sort_order, is_active } = req.body;
    const query = `
      INSERT INTO service_items (name, slug, category_id, description, image_url, rating_text, sort_order, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const [result] = await pool.execute(query, [name, slug, category_id, description, image_url, rating_text, sort_order || 0, is_active]);
    res.json({ id: result.insertId, message: 'Service item created successfully' });
  } catch (error) {
    console.error('Error creating service item:', error);
    res.status(500).json({ error: 'Failed to create service item' });
  }
});

app.put('/api/admin/service-items/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, slug, category_id, description, image_url, rating_text, sort_order, is_active } = req.body;
    const query = `
      UPDATE service_items 
      SET name = ?, slug = ?, category_id = ?, description = ?, image_url = ?, rating_text = ?, sort_order = ?, is_active = ?
      WHERE id = ?
    `;
    await pool.execute(query, [name, slug, category_id, description, image_url, rating_text, sort_order, is_active, id]);
    res.json({ message: 'Service item updated successfully' });
  } catch (error) {
    console.error('Error updating service item:', error);
    res.status(500).json({ error: 'Failed to update service item' });
  }
});

app.delete('/api/admin/service-items/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute('DELETE FROM service_items WHERE id = ?', [id]);
    res.json({ message: 'Service item deleted successfully' });
  } catch (error) {
    console.error('Error deleting service item:', error);
    res.status(500).json({ error: 'Failed to delete service item' });
  }
});

// API endpoints for service_items_category management
app.get('/api/service-items-category', async (req, res) => {
  try {
    const { parentServiceItemSlug, parentCategorySlug } = req.query;
    console.log('Fetching service items categories with filters:', { parentServiceItemSlug, parentCategorySlug });
    
    // First, check what columns exist in the table
    const [columns] = await pool.execute(`SHOW COLUMNS FROM service_items_category`);
    const hasOldColumn = columns.some(col => col.Field === 'parent_category_id');
    const hasNewColumn = columns.some(col => col.Field === 'parent_service_item_id');
    
    console.log('Table schema check:', { hasOldColumn, hasNewColumn });
    
    let query, params = [];
    
    if (hasNewColumn) {
      // Use new schema with parent_service_item_id
      query = `
        SELECT 
          sic.*,
          si.name as parent_service_item_name, 
          si.slug as parent_service_item_slug,
          sc.name as parent_category_name,
          sc.slug as parent_category_slug
        FROM service_items_category sic
        LEFT JOIN service_items si ON sic.parent_service_item_id = si.id
        LEFT JOIN service_categories sc ON si.category_id = sc.id
        WHERE sic.is_active = TRUE
      `;
      
      if (parentServiceItemSlug) {
        query += ' AND si.slug = ?';
        params.push(parentServiceItemSlug);
      }
    } else {
      // Fall back to old schema with parent_category_id
      query = `
        SELECT 
          sic.*,
          sc.name as parent_category_name,
          sc.slug as parent_category_slug
        FROM service_items_category sic
        LEFT JOIN service_categories sc ON sic.parent_category_id = sc.id
        WHERE sic.is_active = TRUE
      `;
      
      if (parentCategorySlug) {
        query += ' AND sc.slug = ?';
        params.push(parentCategorySlug);
      }
    }
    
    query += ' ORDER BY sic.sort_order, sic.name';
    
    console.log('Executing query:', query);
    console.log('With parameters:', params);
    
    const [results] = await pool.execute(query, params);
    console.log('Found', results.length, 'service items categories');
    res.json(results);
  } catch (error) {
    console.error('Error fetching service items categories:', error);
    res.status(500).json({ error: 'Failed to fetch service items categories', details: error.message });
  }
});

// Admin API endpoints for service_items_category management
app.get('/api/admin/service-items-category', async (req, res) => {
  try {
    const detailedQuery = `
      SELECT 
        sic.*,
        si.name as parent_service_item_name, 
        si.slug as parent_service_item_slug,
        sc.name as parent_category_name,
        sc.slug as parent_category_slug
      FROM service_items_category sic
      LEFT JOIN service_items si ON sic.parent_service_item_id = si.id
      LEFT JOIN service_categories sc ON si.category_id = sc.id
      ORDER BY sic.sort_order, sic.name
    `;
    const [results] = await pool.execute(detailedQuery);
    res.json(results);
  } catch (error) {
    console.error('Error fetching admin service items categories:', error);
    res.status(500).json({ 
      error: 'Failed to fetch service items categories',
      details: error.message 
    });
  }
});

// Test endpoint to check table structure
app.get('/api/test/service-items-category-table', async (req, res) => {
  try {
    // Check if table exists and get structure
    const [columns] = await pool.execute(`
      SHOW COLUMNS FROM service_items_category
    `);
    res.json({ 
      message: 'Table exists',
      columns: columns.map(col => ({ name: col.Field, type: col.Type }))
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Table check failed',
      details: error.message 
    });
  }
});

app.post('/api/admin/service-items-category', async (req, res) => {
  try {
    const { name, slug, description, parent_service_item_id, image_url, hero_image_url, icon_url, sort_order, is_active } = req.body;
    const query = `
      INSERT INTO service_items_category (name, slug, description, parent_service_item_id, image_url, hero_image_url, icon_url, sort_order, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const [result] = await pool.execute(query, [name, slug, description, parent_service_item_id || null, image_url, hero_image_url, icon_url, sort_order || 0, is_active]);
    res.json({ id: result.insertId, message: 'Service items category created successfully' });
  } catch (error) {
    console.error('Error creating service items category:', error);
    res.status(500).json({ error: 'Failed to create service items category' });
  }
});

app.put('/api/admin/service-items-category/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, slug, description, parent_service_item_id, image_url, hero_image_url, icon_url, sort_order, is_active } = req.body;
    const query = `
      UPDATE service_items_category 
      SET name = ?, slug = ?, description = ?, parent_service_item_id = ?, image_url = ?, hero_image_url = ?, icon_url = ?, sort_order = ?, is_active = ?
      WHERE id = ?
    `;
    await pool.execute(query, [name, slug, description, parent_service_item_id || null, image_url, hero_image_url, icon_url, sort_order, is_active, id]);
    res.json({ message: 'Service items category updated successfully' });
  } catch (error) {
    console.error('Error updating service items category:', error);
    res.status(500).json({ error: 'Failed to update service items category' });
  }
});

app.delete('/api/admin/service-items-category/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute('DELETE FROM service_items_category WHERE id = ?', [id]);
    res.json({ message: 'Service items category deleted successfully' });
  } catch (error) {
    console.error('Error deleting service items category:', error);
    res.status(500).json({ error: 'Failed to delete service items category' });
  }
});

// Get property types for a specific service items category
app.get('/api/service-items-category/:categoryId/property-types', async (req, res) => {
  try {
    const { categoryId } = req.params;
    const [propertyTypes] = await pool.execute(`
      SELECT pt.* FROM property_types pt
      INNER JOIN service_items_category_property_types sicpt ON pt.id = sicpt.property_type_id
      WHERE sicpt.service_items_category_id = ? AND pt.is_active = TRUE
      ORDER BY pt.sort_order ASC, pt.name ASC
    `, [categoryId]);
    
    return res.json(propertyTypes);
  } catch (error) {
    console.error('Error fetching property types for service category:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get property types for a service items category by slug
app.get('/api/service-items-category-property-types/:categorySlug', async (req, res) => {
  try {
    const { categorySlug } = req.params;
    const [propertyTypes] = await pool.execute(`
      SELECT pt.* FROM property_types pt
      INNER JOIN service_items_category_property_types sicpt ON pt.id = sicpt.property_type_id
      INNER JOIN service_items_category sic ON sicpt.service_items_category_id = sic.id
      WHERE sic.slug = ? AND pt.is_active = TRUE
      ORDER BY pt.sort_order ASC, pt.name ASC
    `, [categorySlug]);
    
    return res.json(propertyTypes);
  } catch (error) {
    console.error('Error fetching property types for service category by slug:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Update property types for a service items category
app.put('/api/admin/service-items-category/:id/property-types', async (req, res) => {
  try {
    const { id } = req.params;
    const { propertyTypeIds } = req.body;
    
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    
    try {
      // Delete existing associations
      await connection.execute(
        'DELETE FROM service_items_category_property_types WHERE service_items_category_id = ?',
        [id]
      );
      
      // Insert new associations
      if (propertyTypeIds && propertyTypeIds.length > 0) {
        const values = propertyTypeIds.map(typeId => [id, typeId]);
        await connection.query(
          'INSERT INTO service_items_category_property_types (service_items_category_id, property_type_id) VALUES ?',
          [values]
        );
      }
      
      await connection.commit();
      res.json({ message: 'Property types updated successfully' });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating property types for service category:', error);
    res.status(500).json({ error: 'Failed to update property types' });
  }
});

// Get all property types (public endpoint)
app.get('/api/property-types', async (req, res) => {
  try {
    const [propertyTypes] = await pool.execute(
      'SELECT * FROM property_types WHERE is_active = TRUE ORDER BY sort_order ASC, name ASC'
    );
    
    return res.json(propertyTypes);
  } catch (error) {
    console.error('Error fetching property types:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get room types for a specific property type (public endpoint)
app.get('/api/property-types/:propertyId/room-types', async (req, res) => {
  try {
    const { propertyId } = req.params;
    
    const [roomTypes] = await pool.execute(
      'SELECT * FROM room_types WHERE property_type_id = ? AND is_active = TRUE ORDER BY sort_order ASC, name ASC',
      [propertyId]
    );
    
    return res.json(roomTypes);
  } catch (error) {
    console.error('Error fetching room types:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get service pricing (public endpoint)
app.get('/api/service-pricing', async (req, res) => {
  try {
    const { categoryId, propertyId } = req.query;
    
    let query = `
      SELECT 
        sp.*,
        sc.name as category_name,
        sc.slug as category_slug,
        pt.name as property_type_name,
        pt.slug as property_type_slug,
        rt.name as room_type_name,
        rt.slug as room_type_slug,
        rt.image_url as room_image,
        rt.description as room_description,
        rt.whats_included as whats_included
      FROM service_pricing sp
      JOIN service_categories sc ON sp.service_category_id = sc.id
      JOIN property_types pt ON sp.property_type_id = pt.id
      JOIN room_types rt ON sp.room_type_id = rt.id
      WHERE sp.is_active = TRUE
    `;
    
    const params = [];
    
    if (categoryId) {
      query += ' AND sp.service_category_id = ?';
      params.push(categoryId);
    }
    
    if (propertyId) {
      query += ' AND sp.property_type_id = ?';
      params.push(propertyId);
    }
    
    query += ' ORDER BY pt.sort_order, rt.sort_order';
    
    const [pricing] = await pool.execute(query, params);
    
    return res.json(pricing);
  } catch (error) {
    console.error('Error fetching service pricing:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ===== ADMIN SERVICE MANAGEMENT ENDPOINTS =====

// Get all service categories (admin)
app.get('/api/admin/service-categories', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [categories] = await pool.execute(
      'SELECT * FROM service_categories ORDER BY sort_order ASC, name ASC'
    );
    
    return res.json(categories);
  } catch (error) {
    console.error('Error fetching service categories:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Create new service category (admin)
app.post('/api/admin/service-categories', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { name, slug, image_url, hero_image_url, description, is_active, sort_order } = req.body;
    
    if (!name || !slug) {
      return res.status(400).json({ message: 'Name and slug are required' });
    }
    
    // Check if slug already exists
    const [existing] = await pool.execute('SELECT id FROM service_categories WHERE slug = ?', [slug]);
    if (existing.length > 0) {
      return res.status(400).json({ message: 'Slug already exists' });
    }
    
    const [result] = await pool.execute(
      'INSERT INTO service_categories (name, slug, image_url, hero_image_url, description, is_active, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [name, slug, image_url || null, hero_image_url || null, description || null, is_active !== false, sort_order || 0, req.user.id]
    );
    
    return res.status(201).json({ 
      id: result.insertId,
      message: 'Service category created successfully'
    });
  } catch (error) {
    console.error('Error creating service category:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Update service category (admin)
app.put('/api/admin/service-categories/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, slug, image_url, hero_image_url, description, is_active, sort_order } = req.body;
    
    // Check if category exists
    const [existing] = await pool.execute('SELECT id FROM service_categories WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Service category not found' });
    }
    
    // Check if slug is unique (excluding current record)
    if (slug) {
      const [slugCheck] = await pool.execute('SELECT id FROM service_categories WHERE slug = ? AND id != ?', [slug, id]);
      if (slugCheck.length > 0) {
        return res.status(400).json({ message: 'Slug already exists' });
      }
    }
    
    await pool.execute(
      'UPDATE service_categories SET name = ?, slug = ?, image_url = ?, hero_image_url = ?, description = ?, is_active = ?, sort_order = ? WHERE id = ?',
      [name, slug, image_url || null, hero_image_url || null, description || null, is_active !== false, sort_order || 0, id]
    );
    
    return res.json({ message: 'Service category updated successfully' });
  } catch (error) {
    console.error('Error updating service category:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Delete service category (admin)
app.delete('/api/admin/service-categories/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if category exists
    const [existing] = await pool.execute('SELECT id FROM service_categories WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Service category not found' });
    }
    
    // Check if category has associated pricing (optional - prevent deletion if has data)
    const [pricingCheck] = await pool.execute('SELECT id FROM service_pricing WHERE service_category_id = ?', [id]);
    if (pricingCheck.length > 0) {
      return res.status(400).json({ message: 'Cannot delete category with associated pricing. Please remove pricing first.' });
    }
    
    await pool.execute('DELETE FROM service_categories WHERE id = ?', [id]);
    
    return res.json({ message: 'Service category deleted successfully' });
  } catch (error) {
    console.error('Error deleting service category:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get all property types (admin)
app.get('/api/admin/property-types', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [propertyTypes] = await pool.execute(
      'SELECT * FROM property_types ORDER BY sort_order ASC, name ASC'
    );
    
    return res.json(propertyTypes);
  } catch (error) {
    console.error('Error fetching property types:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Create new property type (admin)
app.post('/api/admin/property-types', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { name, slug, image_url, description, base_price, is_active, sort_order } = req.body;
    
    if (!name || !slug) {
      return res.status(400).json({ message: 'Name and slug are required' });
    }
    
    // Check if slug already exists
    const [existing] = await pool.execute('SELECT id FROM property_types WHERE slug = ?', [slug]);
    if (existing.length > 0) {
      return res.status(400).json({ message: 'Slug already exists' });
    }
    
    const [result] = await pool.execute(
      'INSERT INTO property_types (name, slug, image_url, description, base_price, is_active, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [name, slug, image_url || null, description || null, base_price || 0, is_active !== false, sort_order || 0, req.user.id]
    );
    
    return res.status(201).json({ 
      id: result.insertId,
      message: 'Property type created successfully'
    });
  } catch (error) {
    console.error('Error creating property type:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Update property type (admin)
app.put('/api/admin/property-types/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, slug, image_url, description, base_price, is_active, sort_order } = req.body;
    
    // Check if property type exists
    const [existing] = await pool.execute('SELECT id FROM property_types WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Property type not found' });
    }
    
    // Check if slug is unique (excluding current record)
    if (slug) {
      const [slugCheck] = await pool.execute('SELECT id FROM property_types WHERE slug = ? AND id != ?', [slug, id]);
      if (slugCheck.length > 0) {
        return res.status(400).json({ message: 'Slug already exists' });
      }
    }
    
    await pool.execute(
      'UPDATE property_types SET name = ?, slug = ?, image_url = ?, description = ?, base_price = ?, is_active = ?, sort_order = ? WHERE id = ?',
      [name, slug, image_url || null, description || null, base_price || 0, is_active !== false, sort_order || 0, id]
    );
    
    return res.json({ message: 'Property type updated successfully' });
  } catch (error) {
    console.error('Error updating property type:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Delete property type (admin) - also remove related room types and pricing inside a transaction
app.delete('/api/admin/property-types/:id', authenticateToken, isAdmin, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;

    await connection.beginTransaction();

    // Make sure property exists
    const [existing] = await connection.execute('SELECT id FROM property_types WHERE id = ?', [id]);
    if (existing.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ message: 'Property type not found' });
    }

    // Delete related service_pricing entries
    await connection.execute('DELETE FROM service_pricing WHERE property_type_id = ?', [id]);

    // Delete related room_types
    await connection.execute('DELETE FROM room_types WHERE property_type_id = ?', [id]);

    // Delete the property type
    await connection.execute('DELETE FROM property_types WHERE id = ?', [id]);

    await connection.commit();
    connection.release();

    return res.json({ message: 'Property type and related data deleted successfully' });
  } catch (error) {
    console.error('Error deleting property type and related data:', error);
    try { await connection.rollback(); } catch (e) { /* ignore */ }
    connection.release();
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get all room types (admin)
app.get('/api/admin/room-types', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT 
        rt.*,
        pt.name as property_type_name
      FROM room_types rt
      LEFT JOIN property_types pt ON rt.property_type_id = pt.id
      ORDER BY pt.name, rt.sort_order, rt.name
    `);
    
    res.json(rows);
  } catch (error) {
    console.error('Error fetching room types:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});




// Admin: Get single page content by slug
app.get('/api/admin/page-contents/:slug', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { slug } = req.params;
    const [rows] = await pool.execute('SELECT * FROM page_contents WHERE slug = ?', [slug]);
    if (rows.length === 0) return res.status(404).json({ message: 'Page not found' });
    return res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching page content (admin):', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Update page content
app.put('/api/admin/page-contents/:slug', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { slug } = req.params;
    const { title, meta, content, is_active } = req.body;

    // Basic validation: content should be object or string
    if (content === undefined) return res.status(400).json({ message: 'Content is required' });

    // Update
    await pool.execute(
      'UPDATE page_contents SET title = ?, meta = ?, content = ?, is_active = ? WHERE slug = ?',
      [title || null, JSON.stringify(meta || null), JSON.stringify(content || null), is_active !== false, slug]
    );

    return res.json({ message: 'Page content updated successfully' });
  } catch (error) {
    console.error('Error updating page content:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// =============================================================================
// DEDICATED CONTENT PAGE APIs
// =============================================================================

// FAQ APIs
// Public: Get all active FAQs grouped by category
app.get('/api/faqs', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT category, question, answer, sort_order FROM faqs WHERE is_active = TRUE ORDER BY category, sort_order, id'
    );
    
    // Group by category
    const groupedFaqs = {};
    const categories = [];
    
    rows.forEach(faq => {
      if (!groupedFaqs[faq.category]) {
        groupedFaqs[faq.category] = [];
        categories.push(faq.category);
      }
      groupedFaqs[faq.category].push({
        question: faq.question,
        answer: faq.answer
      });
    });
    
    return res.json({
      categories,
      faqs: groupedFaqs
    });
  } catch (error) {
    console.error('Error fetching FAQs:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Get all FAQs
app.get('/api/admin/faqs', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM faqs ORDER BY category, sort_order, id'
    );
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching FAQs (admin):', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Create new FAQ
app.post('/api/admin/faqs', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { category, question, answer, sort_order, is_active } = req.body;
    
    if (!category || !question || !answer) {
      return res.status(400).json({ message: 'Category, question, and answer are required' });
    }
    
    const [result] = await pool.execute(
      'INSERT INTO faqs (category, question, answer, sort_order, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [category, question, answer, sort_order || 0, is_active !== false, req.user.id]
    );
    
    return res.status(201).json({ 
      message: 'FAQ created successfully',
      id: result.insertId
    });
  } catch (error) {
    console.error('Error creating FAQ:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Update FAQ
app.put('/api/admin/faqs/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { category, question, answer, sort_order, is_active } = req.body;
    
    if (!category || !question || !answer) {
      return res.status(400).json({ message: 'Category, question, and answer are required' });
    }
    
    await pool.execute(
      'UPDATE faqs SET category = ?, question = ?, answer = ?, sort_order = ?, is_active = ? WHERE id = ?',
      [category, question, answer, sort_order || 0, is_active !== false, id]
    );
    
    return res.json({ message: 'FAQ updated successfully' });
  } catch (error) {
    console.error('Error updating FAQ:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Delete FAQ
app.delete('/api/admin/faqs/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute('DELETE FROM faqs WHERE id = ?', [id]);
    return res.json({ message: 'FAQ deleted successfully' });
  } catch (error) {
    console.error('Error deleting FAQ:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Terms APIs
// Public: Get all active terms sections
app.get('/api/terms', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT section_title, content, sort_order FROM terms WHERE is_active = TRUE ORDER BY sort_order, id'
    );
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching terms:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Get all terms
app.get('/api/admin/terms', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM terms ORDER BY sort_order, id');
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching terms (admin):', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Create new term section
app.post('/api/admin/terms', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { section_title, content, sort_order, is_active } = req.body;
    
    if (!section_title || !content) {
      return res.status(400).json({ message: 'Section title and content are required' });
    }
    
    const [result] = await pool.execute(
      'INSERT INTO terms (section_title, content, sort_order, is_active, created_by) VALUES (?, ?, ?, ?, ?)',
      [section_title, content, sort_order || 0, is_active !== false, req.user.id]
    );
    
    return res.status(201).json({ 
      message: 'Terms section created successfully',
      id: result.insertId
    });
  } catch (error) {
    console.error('Error creating terms section:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Update terms section
app.put('/api/admin/terms/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { section_title, content, sort_order, is_active } = req.body;
    
    if (!section_title || !content) {
      return res.status(400).json({ message: 'Section title and content are required' });
    }
    
    await pool.execute(
      'UPDATE terms SET section_title = ?, content = ?, sort_order = ?, is_active = ? WHERE id = ?',
      [section_title, content, sort_order || 0, is_active !== false, id]
    );
    
    return res.json({ message: 'Terms section updated successfully' });
  } catch (error) {
    console.error('Error updating terms section:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Delete terms section
app.delete('/api/admin/terms/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute('DELETE FROM terms WHERE id = ?', [id]);
    return res.json({ message: 'Terms section deleted successfully' });
  } catch (error) {
    console.error('Error deleting terms section:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Privacy Policy APIs
// Public: Get all active privacy policy sections
app.get('/api/privacy-policy', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT section_title, content, sort_order FROM privacy_policy WHERE is_active = TRUE ORDER BY sort_order, id'
    );
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching privacy policy:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Get all privacy policy sections
app.get('/api/admin/privacy-policy', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM privacy_policy ORDER BY sort_order, id');
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching privacy policy (admin):', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Create new privacy policy section
app.post('/api/admin/privacy-policy', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { section_title, content, sort_order, is_active } = req.body;
    
    if (!section_title || !content) {
      return res.status(400).json({ message: 'Section title and content are required' });
    }
    
    const [result] = await pool.execute(
      'INSERT INTO privacy_policy (section_title, content, sort_order, is_active, created_by) VALUES (?, ?, ?, ?, ?)',
      [section_title, content, sort_order || 0, is_active !== false, req.user.id]
    );
    
    return res.status(201).json({ 
      message: 'Privacy policy section created successfully',
      id: result.insertId
    });
  } catch (error) {
    console.error('Error creating privacy policy section:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Update privacy policy section
app.put('/api/admin/privacy-policy/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { section_title, content, sort_order, is_active } = req.body;
    
    if (!section_title || !content) {
      return res.status(400).json({ message: 'Section title and content are required' });
    }
    
    await pool.execute(
      'UPDATE privacy_policy SET section_title = ?, content = ?, sort_order = ?, is_active = ? WHERE id = ?',
      [section_title, content, sort_order || 0, is_active !== false, id]
    );
    
    return res.json({ message: 'Privacy policy section updated successfully' });
  } catch (error) {
    console.error('Error updating privacy policy section:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Delete privacy policy section
app.delete('/api/admin/privacy-policy/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute('DELETE FROM privacy_policy WHERE id = ?', [id]);
    return res.json({ message: 'Privacy policy section deleted successfully' });
  } catch (error) {
    console.error('Error deleting privacy policy section:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Sitemap APIs
// Public: Get all active sitemap entries grouped by section
app.get('/api/sitemap', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT section_name, page_title, page_url, sort_order FROM sitemap WHERE is_active = TRUE ORDER BY section_name, sort_order, id'
    );
    
    // Group by section
    const groupedSitemap = {};
    rows.forEach(item => {
      if (!groupedSitemap[item.section_name]) {
        groupedSitemap[item.section_name] = [];
      }
      groupedSitemap[item.section_name].push({
        title: item.page_title,
        url: item.page_url
      });
    });
    
    return res.json(groupedSitemap);
  } catch (error) {
    console.error('Error fetching sitemap:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Get all sitemap entries
app.get('/api/admin/sitemap', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM sitemap ORDER BY section_name, sort_order, id');
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching sitemap (admin):', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Create new sitemap entry
app.post('/api/admin/sitemap', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { section_name, page_title, page_url, sort_order, is_active } = req.body;
    
    if (!section_name || !page_title || !page_url) {
      return res.status(400).json({ message: 'Section name, page title, and page URL are required' });
    }
    
    const [result] = await pool.execute(
      'INSERT INTO sitemap (section_name, page_title, page_url, sort_order, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [section_name, page_title, page_url, sort_order || 0, is_active !== false, req.user.id]
    );
    
    return res.status(201).json({ 
      message: 'Sitemap entry created successfully',
      id: result.insertId
    });
  } catch (error) {
    console.error('Error creating sitemap entry:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Update sitemap entry
app.put('/api/admin/sitemap/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { section_name, page_title, page_url, sort_order, is_active } = req.body;
    
    if (!section_name || !page_title || !page_url) {
      return res.status(400).json({ message: 'Section name, page title, and page URL are required' });
    }
    
    await pool.execute(
      'UPDATE sitemap SET section_name = ?, page_title = ?, page_url = ?, sort_order = ?, is_active = ? WHERE id = ?',
      [section_name, page_title, page_url, sort_order || 0, is_active !== false, id]
    );
    
    return res.json({ message: 'Sitemap entry updated successfully' });
  } catch (error) {
    console.error('Error updating sitemap entry:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Delete sitemap entry
app.delete('/api/admin/sitemap/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute('DELETE FROM sitemap WHERE id = ?', [id]);
    return res.json({ message: 'Sitemap entry deleted successfully' });
  } catch (error) {
    console.error('Error deleting sitemap entry:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Careers APIs
// Public: Get all active job postings
app.get('/api/careers', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT job_title, department, location, job_type, description, requirements, benefits, salary_range FROM careers WHERE is_active = TRUE ORDER BY department, job_title'
    );
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching careers:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Get all job postings
app.get('/api/admin/careers', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM careers ORDER BY department, job_title, id');
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching careers (admin):', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Create new job posting
app.post('/api/admin/careers', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { job_title, department, location, job_type, description, requirements, benefits, salary_range, is_active } = req.body;
    
    if (!job_title || !department || !location || !description) {
      return res.status(400).json({ message: 'Job title, department, location, and description are required' });
    }
    
    const [result] = await pool.execute(
      'INSERT INTO careers (job_title, department, location, job_type, description, requirements, benefits, salary_range, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [job_title, department, location, job_type || 'full-time', description, requirements || null, benefits || null, salary_range || null, is_active !== false, req.user.id]
    );
    
    return res.status(201).json({ 
      message: 'Job posting created successfully',
      id: result.insertId
    });
  } catch (error) {
    console.error('Error creating job posting:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Update job posting
app.put('/api/admin/careers/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { job_title, department, location, job_type, description, requirements, benefits, salary_range, is_active } = req.body;
    
    if (!job_title || !department || !location || !description) {
      return res.status(400).json({ message: 'Job title, department, location, and description are required' });
    }
    
    await pool.execute(
      'UPDATE careers SET job_title = ?, department = ?, location = ?, job_type = ?, description = ?, requirements = ?, benefits = ?, salary_range = ?, is_active = ? WHERE id = ?',
      [job_title, department, location, job_type || 'full-time', description, requirements || null, benefits || null, salary_range || null, is_active !== false, id]
    );
    
    return res.json({ message: 'Job posting updated successfully' });
  } catch (error) {
    console.error('Error updating job posting:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Delete job posting
app.delete('/api/admin/careers/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute('DELETE FROM careers WHERE id = ?', [id]);
    return res.json({ message: 'Job posting deleted successfully' });
  } catch (error) {
    console.error('Error deleting job posting:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// FAQ APIs
// Public: Get all active FAQs grouped by category
app.get('/api/faqs', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT category, question, answer, sort_order FROM faqs WHERE is_active = TRUE ORDER BY category, sort_order, id'
    );
    
    // Group by category
    const groupedFaqs = {};
    rows.forEach(item => {
      if (!groupedFaqs[item.category]) {
        groupedFaqs[item.category] = [];
      }
      groupedFaqs[item.category].push({
        question: item.question,
        answer: item.answer
      });
    });
    
    return res.json(groupedFaqs);
  } catch (error) {
    console.error('Error fetching FAQs:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Get all FAQs
app.get('/api/admin/faqs', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM faqs ORDER BY category, sort_order, id');
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching FAQs (admin):', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Create new FAQ
app.post('/api/admin/faqs', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { category, question, answer, sort_order, is_active } = req.body;
    
    if (!category || !question || !answer) {
      return res.status(400).json({ message: 'Category, question, and answer are required' });
    }
    
    const [result] = await pool.execute(
      'INSERT INTO faqs (category, question, answer, sort_order, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [category, question, answer, sort_order || 0, is_active !== false, req.user.id]
    );
    
    return res.status(201).json({ 
      message: 'FAQ created successfully',
      id: result.insertId
    });
  } catch (error) {
    console.error('Error creating FAQ:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Update FAQ
app.put('/api/admin/faqs/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { category, question, answer, sort_order, is_active } = req.body;
    
    if (!category || !question || !answer) {
      return res.status(400).json({ message: 'Category, question, and answer are required' });
    }
    
    await pool.execute(
      'UPDATE faqs SET category = ?, question = ?, answer = ?, sort_order = ?, is_active = ? WHERE id = ?',
      [category, question, answer, sort_order || 0, is_active !== false, id]
    );
    
    return res.json({ message: 'FAQ updated successfully' });
  } catch (error) {
    console.error('Error updating FAQ:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Delete FAQ
app.delete('/api/admin/faqs/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute('DELETE FROM faqs WHERE id = ?', [id]);
    return res.json({ message: 'FAQ deleted successfully' });
  } catch (error) {
    console.error('Error deleting FAQ:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Terms APIs
// Public: Get all active terms sections
app.get('/api/terms', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT section_title, content, sort_order FROM terms WHERE is_active = TRUE ORDER BY sort_order, id'
    );
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching terms:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Get all terms sections
app.get('/api/admin/terms', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM terms ORDER BY sort_order, id');
    return res.json(rows);
  } catch (error) {
    console.error('Error fetching terms (admin):', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Create new terms section
app.post('/api/admin/terms', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { section_title, content, sort_order, is_active } = req.body;
    
    if (!section_title || !content) {
      return res.status(400).json({ message: 'Section title and content are required' });
    }
    
    const [result] = await pool.execute(
      'INSERT INTO terms (section_title, content, sort_order, is_active, created_by) VALUES (?, ?, ?, ?, ?)',
      [section_title, content, sort_order || 0, is_active !== false, req.user.id]
    );
    
    return res.status(201).json({ 
      message: 'Terms section created successfully',
      id: result.insertId
    });
  } catch (error) {
    console.error('Error creating terms section:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Update terms section
app.put('/api/admin/terms/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { section_title, content, sort_order, is_active } = req.body;
    
    if (!section_title || !content) {
      return res.status(400).json({ message: 'Section title and content are required' });
    }
    
    await pool.execute(
      'UPDATE terms SET section_title = ?, content = ?, sort_order = ?, is_active = ? WHERE id = ?',
      [section_title, content, sort_order || 0, is_active !== false, id]
    );
    
    return res.json({ message: 'Terms section updated successfully' });
  } catch (error) {
    console.error('Error updating terms section:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Delete terms section
app.delete('/api/admin/terms/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute('DELETE FROM terms WHERE id = ?', [id]);
    return res.json({ message: 'Terms section deleted successfully' });
  } catch (error) {
    console.error('Error deleting terms section:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Create new room type (admin)
app.post('/api/admin/room-types', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { property_type_id, name, slug, image_url, description, whats_included, is_active, sort_order } = req.body;
    
    if (!property_type_id || !name || !slug) {
      return res.status(400).json({ message: 'Property type ID, name and slug are required' });
    }
    
    // Check if property type exists
    const [propertyExists] = await pool.execute('SELECT id FROM property_types WHERE id = ?', [property_type_id]);
    if (propertyExists.length === 0) {
      return res.status(400).json({ message: 'Property type not found' });
    }
    
    // Check if slug already exists for this property type
    const [existing] = await pool.execute('SELECT id FROM room_types WHERE slug = ? AND property_type_id = ?', [slug, property_type_id]);
    if (existing.length > 0) {
      return res.status(400).json({ message: 'Slug already exists for this property type' });
    }
    
    const [result] = await pool.execute(
      'INSERT INTO room_types (property_type_id, name, slug, image_url, description, whats_included, is_active, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [property_type_id, name, slug, image_url || null, description || null, JSON.stringify(whats_included || []), is_active !== false, sort_order || 0, req.user.id]
    );
    
    return res.status(201).json({ 
      id: result.insertId,
      message: 'Room type created successfully'
    });
  } catch (error) {
    console.error('Error creating room type:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Update room type (admin)
app.put('/api/admin/room-types/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, slug, image_url, description, whats_included, is_active, sort_order } = req.body;
    
    // Check if room type exists
    const [existing] = await pool.execute('SELECT property_type_id FROM room_types WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Room type not found' });
    }
    
    const propertyTypeId = existing[0].property_type_id;
    
    // Check if slug is unique (excluding current record)
    if (slug) {
      const [slugCheck] = await pool.execute('SELECT id FROM room_types WHERE slug = ? AND property_type_id = ? AND id != ?', [slug, propertyTypeId, id]);
      if (slugCheck.length > 0) {
        return res.status(400).json({ message: 'Slug already exists for this property type' });
      }
    }
    
    await pool.execute(
      'UPDATE room_types SET name = ?, slug = ?, image_url = ?, description = ?, whats_included = ?, is_active = ?, sort_order = ? WHERE id = ?',
      [name, slug, image_url || null, description || null, JSON.stringify(whats_included || []), is_active !== false, sort_order || 0, id]
    );
    
    return res.json({ message: 'Room type updated successfully' });
  } catch (error) {
    console.error('Error updating room type:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get service pricing (admin)
app.get('/api/admin/service-pricing', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [pricing] = await pool.execute(`
      SELECT 
        sp.*,
        sc.name as category_name,
        sc.slug as category_slug,
        pt.name as property_type_name,
        pt.slug as property_type_slug,
        rt.name as room_type_name,
        rt.slug as room_type_slug,
        rt.image_url as room_image,
        rt.description as room_description
      FROM service_pricing sp
      JOIN service_categories sc ON sp.service_category_id = sc.id
      JOIN property_types pt ON sp.property_type_id = pt.id
      JOIN room_types rt ON sp.room_type_id = rt.id
      ORDER BY sc.sort_order, pt.sort_order, rt.sort_order
    `);
    
    return res.json(pricing);
  } catch (error) {
    console.error('Error fetching service pricing:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Create or update service pricing (admin)
app.post('/api/admin/service-pricing', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { service_category_id, property_type_id, room_type_id, price, discount_price, max_orders, description, is_special, is_active } = req.body;
    
    if (!service_category_id || !property_type_id || !room_type_id || price === undefined) {
      return res.status(400).json({ message: 'Service category, property type, room type, and price are required' });
    }
    
    // Check if pricing already exists
    const [existing] = await pool.execute(
      'SELECT id FROM service_pricing WHERE service_category_id = ? AND property_type_id = ? AND room_type_id = ?',
      [service_category_id, property_type_id, room_type_id]
    );
    
    if (existing.length > 0) {
      // Update existing pricing
      await pool.execute(
        'UPDATE service_pricing SET price = ?, discount_price = ?, max_orders = ?, description = ?, is_special = ?, is_active = ? WHERE id = ?',
        [price, discount_price || null, max_orders || null, description || null, is_special || false, is_active !== false, existing[0].id]
      );
      
      return res.json({ message: 'Service pricing updated successfully' });
    } else {
      // Create new pricing
      const [result] = await pool.execute(
        'INSERT INTO service_pricing (service_category_id, property_type_id, room_type_id, price, discount_price, max_orders, description, is_special, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [service_category_id, property_type_id, room_type_id, price, discount_price || null, max_orders || null, description || null, is_special || false, is_active !== false, req.user.id]
      );
      
      return res.status(201).json({ 
        id: result.insertId,
        message: 'Service pricing created successfully'
      });
    }
  } catch (error) {
    console.error('Error creating/updating service pricing:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Update service pricing (admin)
app.put('/api/admin/service-pricing/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { service_category_id, property_type_id, room_type_id, price, discount_price, max_orders, description, is_special, is_active } = req.body;
    
    if (!service_category_id || !property_type_id || !room_type_id || price === undefined) {
      return res.status(400).json({ message: 'Service category, property type, room type, and price are required' });
    }
    
    // Check if pricing exists
    const [existing] = await pool.execute('SELECT id FROM service_pricing WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Service pricing not found' });
    }
    
    // Delete any duplicate entries for this combination (excluding current record)
    await pool.execute(
      'DELETE FROM service_pricing WHERE service_category_id = ? AND property_type_id = ? AND room_type_id = ? AND id != ?',
      [service_category_id, property_type_id, room_type_id, id]
    );
    
    await pool.execute(
      'UPDATE service_pricing SET service_category_id = ?, property_type_id = ?, room_type_id = ?, price = ?, discount_price = ?, max_orders = ?, description = ?, is_special = ?, is_active = ? WHERE id = ?',
      [service_category_id, property_type_id, room_type_id, price, discount_price || null, max_orders || null, description || null, is_special || false, is_active !== false, id]
    );
    
    return res.json({ message: 'Service pricing updated successfully' });
  } catch (error) {
    console.error('Error updating service pricing:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Delete service pricing (admin)
app.delete('/api/admin/service-pricing/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if pricing exists
    const [existing] = await pool.execute('SELECT id FROM service_pricing WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Service pricing not found' });
    }
    
    await pool.execute('DELETE FROM service_pricing WHERE id = ?', [id]);
    
    return res.json({ message: 'Service pricing deleted successfully' });
  } catch (error) {
    console.error('Error deleting service pricing:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Middleware to authenticate JWT token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  // Enhanced logging for debugging
  console.log('Backend - Authentication attempt:', {
    method: req.method,
    url: req.url,
    authHeader: authHeader ? `Bearer ${authHeader.split(' ')[1]?.substring(0, 20)}...` : 'Not provided',
    hasToken: !!token,
    userAgent: req.headers['user-agent']?.substring(0, 100),
    origin: req.headers.origin
  });
  
  if (!token) {
    console.log('Backend - Authentication failed: No token provided');
    return res.status(401).json({ 
      message: 'Authentication required',
      error_code: 'NO_TOKEN'
    });
  }
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.log('Backend - Authentication failed: Invalid token:', {
        error: err.message,
        tokenStart: token.substring(0, 20) + '...'
      });
      return res.status(403).json({ 
        message: 'Invalid or expired token',
        error_code: 'INVALID_TOKEN'
      });
    }
    
    console.log('Backend - Authentication successful:', {
      userId: user.id,
      tokenValid: true
    });
    
    req.user = user;
    next();
  });
}

// Middleware to check if user is super admin
async function isSuperAdmin(req, res, next) {
  try {
    if (!pool) {
      return res.status(500).json({ message: 'Database not available' });
    }
    
    const [rows] = await pool.execute('SELECT role FROM users WHERE id = ?', [req.user.id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    const userRole = rows[0].role;
    if (userRole !== 'super_admin') {
      return res.status(403).json({ message: 'Super admin access required' });
    }
    
    next();
  } catch (error) {
    console.error('Error checking user role:', error);
    return res.status(500).json({ message: 'Server error' });
  }
}

// Middleware to check if user is admin
async function isAdmin(req, res, next) {
  try {
    if (!pool) {
      return res.status(500).json({ message: 'Database not available' });
    }
    
    const [rows] = await pool.execute('SELECT role FROM users WHERE id = ?', [req.user.id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    const userRole = rows[0].role;
    if (userRole !== 'admin' && userRole !== 'super_admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    
    next();
  } catch (error) {
    console.error('Error checking user role:', error);
    return res.status(500).json({ message: 'Server error' });
  }
}

// Website Settings API

// Get website settings (public endpoint)
app.get('/api/website-settings', async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ message: 'Database not available' });
    }
    
    const [rows] = await pool.execute(
      'SELECT * FROM website_settings WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1'
    );
    
    if (rows.length === 0) {
      // Return default settings if none found
      return res.json({
        site_name: 'JL Services',
        logo_url: '/jl-logo.svg',
        tagline: 'Your trusted home services partner',
        primary_color: '#FFD03E',
        facebook_url: '',
        instagram_url: '',
        twitter_url: '',
        linkedin_url: '',
        google_url: '',
        whatsapp_url: ''
      });
    }
    
    return res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching website settings:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get website settings for admin (requires super admin role)
app.get('/api/admin/website-settings', authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM website_settings ORDER BY created_at DESC LIMIT 1'
    );
    
    if (rows.length === 0) {
      // Return default settings if none found
      return res.json({
        site_name: 'JL Services',
        logo_url: '/jl-logo.svg',
        tagline: 'Your trusted home services partner',
        primary_color: '#FFD03E',
        facebook_url: '',
        instagram_url: '',
        twitter_url: '',
        linkedin_url: '',
        google_url: '',
        whatsapp_url: ''
      });
    }
    
    return res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching website settings:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Update website settings (requires super admin role)
app.put('/api/admin/website-settings', authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    const {
      site_name,
      logo_url,
      tagline,
      primary_color,
      facebook_url,
      instagram_url,
      twitter_url,
      linkedin_url,
      google_url,
      whatsapp_url,
      contact_address,
      contact_phone,
      contact_email
    } = req.body;
    
    // Validate required fields
    if (!site_name || !tagline || !primary_color) {
      return res.status(400).json({ message: 'Site name, tagline, and primary color are required' });
    }
    
    // Check if settings already exist
    const [existing] = await pool.execute('SELECT id FROM website_settings WHERE is_active = TRUE LIMIT 1');
    
    if (existing.length > 0) {
      // Update existing settings
      await pool.execute(
        `UPDATE website_settings SET 
         site_name = ?, logo_url = ?, tagline = ?, primary_color = ?,
         facebook_url = ?, instagram_url = ?, twitter_url = ?, linkedin_url = ?,
         google_url = ?, whatsapp_url = ?, contact_address = ?, contact_phone = ?, contact_email = ?, updated_at = NOW()
         WHERE id = ?`,
        [
          site_name, logo_url || '/jl-logo.svg', tagline, primary_color,
          facebook_url || '', instagram_url || '', twitter_url || '', linkedin_url || '',
          google_url || '', whatsapp_url || '', contact_address || '', contact_phone || '', contact_email || '', existing[0].id
        ]
      );
    } else {
      // Create new settings
      await pool.execute(
        `INSERT INTO website_settings 
         (site_name, logo_url, tagline, primary_color, facebook_url, instagram_url, 
          twitter_url, linkedin_url, google_url, whatsapp_url, contact_address, contact_phone, contact_email, created_by) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          site_name, logo_url || '/jl-logo.svg', tagline, primary_color,
          facebook_url || '', instagram_url || '', twitter_url || '', linkedin_url || '',
          google_url || '', whatsapp_url || '', contact_address || '', contact_phone || '', contact_email || '', req.user.id
        ]
      );
    }
    
    return res.json({ message: 'Website settings updated successfully' });
  } catch (error) {
    console.error('Error updating website settings:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Initialize the database and start the server
async function startServer() {
  // Initialize database first and get the configured pool
  pool = await initializeDatabase();
  
  // Start the server
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// Insert default service items data
async function insertDefaultServiceItems() {
  try {
    const [existing] = await pool.execute('SELECT COUNT(*) as count FROM service_items');
    if (existing[0].count > 0) {
      console.log('Service items already exist');
      return;
    }

    const [categories] = await pool.execute('SELECT id, slug FROM service_categories');
    const categoryMap = {};
    categories.forEach(cat => { categoryMap[cat.slug] = cat.id; });

    const items = [
      { name: 'Home Cleaning', slug: 'home-cleaning', category: 'general-cleaning', description: 'Complete home cleaning service including all rooms', image_url: '/general_cleaning/1.webp', sort_order: 1 },
      { name: 'Kitchen & Bathroom Deep Clean', slug: 'kitchen-bathroom-deep-clean', category: 'general-cleaning', description: 'Deep cleaning for kitchen and bathroom areas', image_url: '/general_cleaning/2.webp', sort_order: 2 },
      { name: 'Hair Services', slug: 'hair-services', category: 'salon-spa', description: 'Professional hair cutting and styling services', image_url: '/salons_and_spa/1.webp', sort_order: 1 },
      { name: 'Facial Treatments', slug: 'facial-treatments', category: 'salon-spa', description: 'Rejuvenating facial treatments and skincare', image_url: '/salons_and_spa/2.webp', sort_order: 2 },
      { name: 'Nursing Care', slug: 'nursing-care', category: 'healthcare-at-home', description: 'Professional nursing care at home', image_url: '/healthcare_at_home/1.webp', sort_order: 1 }
    ];

    for (const item of items) {
      const categoryId = categoryMap[item.category];
      if (categoryId) {
        await pool.execute(
          `INSERT INTO service_items (name, slug, category_id, description, image_url, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?, true)`,
          [item.name, item.slug, categoryId, item.description, item.image_url, item.sort_order]
        );
      }
    }
    console.log('Default service items inserted successfully');
  } catch (error) {
    console.error('Error inserting default service items:', error);
  }
}

// Start the application
startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});