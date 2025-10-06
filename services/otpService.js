const twilio = require('twilio');
require('dotenv').config();

// Twilio configuration
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

// WhatsApp configuration
const whatsappNumber = `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`; // whatsapp:+13083205264

// Test mode configuration
const TEST_MODE = false;
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

// Send WhatsApp OTP
async function sendWhatsAppOTP(phoneNumber) {
  try {
    let formattedPhone = phoneNumber;
    if (!formattedPhone.startsWith('+')) {
      formattedPhone = '+' + formattedPhone;
    }

    const otp = generateOTP();
    
    // Store OTP with 5-minute expiration
    const expiresAt = Date.now() + 5 * 60 * 1000;
    otpStorage.set(formattedPhone, {
      otp,
      expiresAt,
      attempts: 0
    });

    console.log(`📱 Sending WhatsApp OTP to ${formattedPhone}`);

    // Send WhatsApp message using approved template
    // NOTE: Replace 'HX...' with your actual OTP template SID once created
    const message = await client.messages.create({
      from: whatsappNumber,
      to: `whatsapp:${formattedPhone}`,
      contentSid: 'HXec15ca8b9fbdd2f74304ea70100a3f72', // Replace with your OTP template SID
      contentVariables: JSON.stringify({
        "1": otp
      })
    });

    console.log(`✅ WhatsApp OTP sent: ${message.sid}`);
    
    return {
      success: true,
      message: 'WhatsApp OTP sent successfully',
      messageId: message.sid,
      method: 'whatsapp'
    };

  } catch (error) {
    console.error('❌ WhatsApp OTP Error:', error);
    return {
      success: false,
      message: 'Failed to send WhatsApp OTP',
      error: error.message,
      method: 'whatsapp'
    };
  }
}

// Send SMS OTP (fallback)
async function sendSMSOTP(phoneNumber) {
  try {
    let formattedPhone = phoneNumber;
    if (!formattedPhone.startsWith('+')) {
      formattedPhone = '+' + formattedPhone;
    }

    const otp = generateOTP();
    
    // Store OTP with 5-minute expiration
    const expiresAt = Date.now() + 5 * 60 * 1000;
    otpStorage.set(formattedPhone, {
      otp,
      expiresAt,
      attempts: 0
    });

    console.log(`📨 Sending SMS OTP to ${formattedPhone}`);

    const message = await client.messages.create({
      body: `Your AppointPro verification code is: ${otp}. This code will expire in 5 minutes.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: formattedPhone
    });

    console.log(`✅ SMS OTP sent: ${message.sid}`);
    
    return {
      success: true,
      message: 'SMS OTP sent successfully',
      messageId: message.sid,
      method: 'sms'
    };

  } catch (error) {
    console.error('❌ SMS OTP Error:', error);
    return {
      success: false,
      message: 'Failed to send SMS OTP',
      error: error.message,
      method: 'sms'
    };
  }
}

// Main OTP function - WhatsApp first, SMS fallback
async function sendOTP(phoneNumber) {
  try {
    let formattedPhone = phoneNumber;
    if (!formattedPhone.startsWith('+')) {
      formattedPhone = '+' + formattedPhone;
    }
    
    // In TEST_MODE, always use test mode
    if (TEST_MODE) {
      const otp = TEST_OTP;
      
      const expiresAt = Date.now() + 5 * 60 * 1000;
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
        testOtp: otp
      };
    }
    
    console.log(`🚀 Sending OTP to ${formattedPhone} - WhatsApp first`);
    
    // Try WhatsApp first
    const whatsappResult = await sendWhatsAppOTP(formattedPhone);
    
    if (whatsappResult.success) {
      console.log(`✅ WhatsApp OTP successful for ${formattedPhone}`);
      return whatsappResult;
    }
    
    // WhatsApp failed, try SMS fallback
    console.log(`⚠️ WhatsApp failed, trying SMS fallback...`);
    console.log(`WhatsApp Error: ${whatsappResult.message}`);
    
    const smsResult = await sendSMSOTP(formattedPhone);
    
    if (smsResult.success) {
      console.log(`✅ SMS fallback successful for ${formattedPhone}`);
      return {
        ...smsResult,
        message: smsResult.message + ' (SMS fallback used)',
        fallbackUsed: true,
        primaryMethod: 'whatsapp',
        fallbackMethod: 'sms'
      };
    }
    
    // Both methods failed
    console.log(`❌ Both WhatsApp and SMS failed for ${formattedPhone}`);
    return {
      success: false,
      message: 'Failed to send OTP via WhatsApp and SMS',
      whatsappError: whatsappResult.message,
      smsError: smsResult.message
    };
    
  } catch (error) {
    console.error('❌ Error in sendOTP:', error);
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
  sendWhatsAppOTP,
  sendSMSOTP,
  verifyOTP,
  cleanExpiredOTPs
};
