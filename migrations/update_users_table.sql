-- Migration script to update users table for OTP-only authentication
-- This makes email, address, and password optional

USE gsmarena_appointpro;

-- Make email column nullable and remove unique constraint temporarily
ALTER TABLE users 
MODIFY COLUMN email VARCHAR(100) NULL;

-- Make address column nullable  
ALTER TABLE users 
MODIFY COLUMN address JSON NULL;

-- Make password column nullable
ALTER TABLE users 
MODIFY COLUMN password VARCHAR(255) NULL;

-- Add unique constraint back to email but allow nulls
-- Note: MySQL allows multiple NULL values in unique columns
ALTER TABLE users 
ADD CONSTRAINT unique_email_not_null 
UNIQUE (email);

-- Optional: Add a column to track if user registered via OTP
ALTER TABLE users 
ADD COLUMN registered_via_otp BOOLEAN DEFAULT FALSE;

-- Update existing users to mark them as non-OTP users
UPDATE users SET registered_via_otp = FALSE WHERE registered_via_otp IS NULL;