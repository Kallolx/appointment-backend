const twilio = require('twilio');
require('dotenv').config();

// Twilio configuration
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

// Test mode configuration
const TEST_MODE = true;
const TEST_PHONE_NUMBERS = [
  '+971501234567',
];
const TEST_OTP = '123456';

// In-memory storage for OTPs (in production, use Redis or database)
const otpStorage = new Map();

// Generate a 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send OTP via SMS
async function sendOTP(phoneNumber) {
  try {
    // Format phone number for Dubai/UAE
    let formattedPhone = phoneNumber;
    if (!formattedPhone.startsWith('+')) {
      formattedPhone = '+' + formattedPhone;
    }
    
    // In TEST_MODE, always use test mode regardless of phone number
    if (TEST_MODE) {
      // Test mode - don't send actual SMS
      const otp = TEST_OTP;
      
      // Store OTP with 5-minute expiration
      const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
      otpStorage.set(formattedPhone, {
        otp,
        expiresAt,
        attempts: 0
      });
      
      console.log(`TEST MODE: OTP for ${formattedPhone} is: ${otp}`);
      return {
        success: true,
        message: 'OTP sent successfully (Test Mode)',
        messageId: 'test_' + Date.now(),
        testMode: true,
        testOtp: otp // Include OTP in response for testing
      };
    }
    
    // Production mode - send actual SMS via Twilio
    const otp = generateOTP();
    
    // Store OTP with 5-minute expiration
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
    otpStorage.set(formattedPhone, {
      otp,
      expiresAt,
      attempts: 0
    });
    
    const message = await client.messages.create({
      body: `Your AppointPro verification code is: ${otp}. This code will expire in 5 minutes.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: formattedPhone
    });
    
    console.log(`OTP sent to ${formattedPhone}: ${message.sid}`);
    
    return {
      success: true,
      message: 'OTP sent successfully',
      messageId: message.sid
    };
  } catch (error) {
    console.error('Error sending OTP:', error);
    return {
      success: false,
      message: 'Failed to send OTP',
      error: error.message
    };
  }
}

// Verify OTP
function verifyOTP(phoneNumber, otp) {
  try {
    // Format phone number for consistency
    let formattedPhone = phoneNumber;
    if (!formattedPhone.startsWith('+')) {
      formattedPhone = '+' + formattedPhone;
    }
    
    const storedData = otpStorage.get(formattedPhone);
    
    if (!storedData) {
      return {
        success: false,
        message: 'OTP not found or expired'
      };
    }
    
    // Check if OTP is expired
    if (Date.now() > storedData.expiresAt) {
      otpStorage.delete(formattedPhone);
      return {
        success: false,
        message: 'OTP has expired'
      };
    }
    
    // Check attempts (max 3 attempts)
    if (storedData.attempts >= 3) {
      otpStorage.delete(formattedPhone);
      return {
        success: false,
        message: 'Maximum verification attempts exceeded'
      };
    }
    
    // Verify OTP
    if (storedData.otp === otp) {
      otpStorage.delete(formattedPhone); // Remove OTP after successful verification
      return {
        success: true,
        message: 'OTP verified successfully'
      };
    } else {
      // Increment attempts
      storedData.attempts += 1;
      otpStorage.set(formattedPhone, storedData);
      
      return {
        success: false,
        message: `Invalid OTP. ${3 - storedData.attempts} attempts remaining`
      };
    }
  } catch (error) {
    console.error('Error verifying OTP:', error);
    return {
      success: false,
      message: 'Failed to verify OTP',
      error: error.message
    };
  }
}

// Clean expired OTPs (call this periodically)
function cleanExpiredOTPs() {
  const now = Date.now();
  for (const [phoneNumber, data] of otpStorage.entries()) {
    if (now > data.expiresAt) {
      otpStorage.delete(phoneNumber);
    }
  }
}

// Clean expired OTPs every 5 minutes
setInterval(cleanExpiredOTPs, 5 * 60 * 1000);

module.exports = {
  sendOTP,
  verifyOTP,
  cleanExpiredOTPs
};
