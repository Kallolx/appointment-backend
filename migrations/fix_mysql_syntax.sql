-- Fixed database migration script for VPS deployment
-- This addresses the MySQL syntax issues

USE mpcpest;

-- Fix 1: Proper way to add columns if they don't exist
-- Check and add priority column
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
   WHERE TABLE_SCHEMA = 'mpcpest' 
   AND TABLE_NAME = 'support_tickets' 
   AND COLUMN_NAME = 'priority') = 0,
  'ALTER TABLE support_tickets ADD COLUMN priority ENUM(''low'', ''medium'', ''high'') DEFAULT ''medium''',
  'SELECT "Priority column already exists" as message'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Check and add admin_response column
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
   WHERE TABLE_SCHEMA = 'mpcpest' 
   AND TABLE_NAME = 'support_tickets' 
   AND COLUMN_NAME = 'admin_response') = 0,
  'ALTER TABLE support_tickets ADD COLUMN admin_response TEXT NULL',
  'SELECT "Admin response column already exists" as message'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Check and add admin_id column
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
   WHERE TABLE_SCHEMA = 'mpcpest' 
   AND TABLE_NAME = 'support_tickets' 
   AND COLUMN_NAME = 'admin_id') = 0,
  'ALTER TABLE support_tickets ADD COLUMN admin_id INT NULL',
  'SELECT "Admin ID column already exists" as message'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Fix 2: Proper way to add foreign key constraints
-- Drop existing foreign key if it exists, then recreate
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE 
   WHERE TABLE_SCHEMA = 'mpcpest' 
   AND TABLE_NAME = 'support_tickets' 
   AND CONSTRAINT_NAME = 'fk_support_tickets_admin') > 0,
  'ALTER TABLE support_tickets DROP FOREIGN KEY fk_support_tickets_admin',
  'SELECT "Foreign key does not exist" as message'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add the foreign key constraint
ALTER TABLE support_tickets 
ADD CONSTRAINT fk_support_tickets_admin 
FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL;

-- Fix 3: Handle TEXT columns without default values properly
-- Create website_settings table without default TEXT values
CREATE TABLE IF NOT EXISTS website_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  site_name VARCHAR(255) DEFAULT 'AppointPro',
  logo_url VARCHAR(500) DEFAULT '/logo.svg',
  tagline VARCHAR(500) DEFAULT 'Your trusted service provider',
  primary_color VARCHAR(7) DEFAULT '#007bff',
  secondary_color VARCHAR(7) DEFAULT '#6c757d',
  facebook_url VARCHAR(500) DEFAULT '',
  instagram_url VARCHAR(500) DEFAULT '',
  twitter_url VARCHAR(500) DEFAULT '',
  linkedin_url VARCHAR(500) DEFAULT '',
  youtube_url VARCHAR(500) DEFAULT '',
  google_url VARCHAR(500) DEFAULT '',
  whatsapp_url VARCHAR(500) DEFAULT '',
  contact_address TEXT, -- Remove DEFAULT for TEXT column
  contact_phone VARCHAR(50) DEFAULT '+971 4 506 1500',
  contact_email VARCHAR(255) DEFAULT 'support@servicemarket.com',
  is_active BOOLEAN DEFAULT TRUE,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Insert default contact_address after table creation
INSERT IGNORE INTO website_settings (contact_address) 
VALUES ('1403, Fortune Executive Tower, Cluster T, JLT, Dubai, UAE.')
ON DUPLICATE KEY UPDATE contact_address = VALUES(contact_address);

-- Fix 4: Handle parent_service_item_id column properly
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
   WHERE TABLE_SCHEMA = 'mpcpest' 
   AND TABLE_NAME = 'service_items_category' 
   AND COLUMN_NAME = 'parent_service_item_id') = 0,
  'ALTER TABLE service_items_category ADD COLUMN parent_service_item_id INT NULL',
  'SELECT "parent_service_item_id column already exists" as message'
));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

COMMIT;