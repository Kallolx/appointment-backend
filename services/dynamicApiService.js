// Dynamic API Configuration Service
let apiConfigCache = {};
let cacheTimestamp = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Get API configuration from database
async function getApiConfig(serviceName, pool) {
  try {
    // Check cache first
    const now = Date.now();
    if (apiConfigCache[serviceName] && (now - cacheTimestamp < CACHE_DURATION)) {
      return apiConfigCache[serviceName];
    }

    if (!pool) {
      throw new Error('Database pool not available');
    }

    const [configs] = await pool.execute(
      'SELECT api_key, additional_config FROM api_configurations WHERE service_name = ? AND status = "active"',
      [serviceName]
    );

    if (configs.length === 0) {
      return null;
    }

    const config = configs[0];
    const result = {
      api_key: config.api_key,
      additional_config: config.additional_config ? JSON.parse(config.additional_config) : {}
    };

    // Update cache
    apiConfigCache[serviceName] = result;
    cacheTimestamp = now;

    return result;
  } catch (error) {
    console.error(`Error fetching ${serviceName} config:`, error);
    return null;
  }
}

// Clear API config cache
function clearApiConfigCache() {
  apiConfigCache = {};
  cacheTimestamp = 0;
}

// Get Twilio client with dynamic configuration
async function getTwilioClient(pool) {
  try {
    const config = await getApiConfig('twilio', pool);
    
    if (!config) {
      console.error('Twilio configuration not found in database');
      return null;
    }

    const twilio = require('twilio');
    const client = twilio(config.api_key, config.additional_config.auth_token);
    
    return {
      client,
      phoneNumber: config.additional_config.phone_number
    };
  } catch (error) {
    console.error('Error creating Twilio client:', error);
    return null;
  }
}

// Send SMS using dynamic Twilio configuration
async function sendSMS(to, message, pool) {
  try {
    const twilioConfig = await getTwilioClient(pool);
    
    if (!twilioConfig) {
      throw new Error('Twilio not configured');
    }

    const result = await twilioConfig.client.messages.create({
      body: message,
      from: twilioConfig.phoneNumber,
      to: to
    });

    console.log('SMS sent successfully:', result.sid);
    return { success: true, sid: result.sid };
  } catch (error) {
    console.error('Error sending SMS:', error);
    return { success: false, error: error.message };
  }
}

// Send OTP using dynamic configuration
async function sendDynamicOTP(phoneNumber, otp, pool) {
  const message = `Your verification code is: ${otp}. This code will expire in 10 minutes.`;
  return await sendSMS(phoneNumber, message, pool);
}

module.exports = {
  getApiConfig,
  clearApiConfigCache,
  getTwilioClient,
  sendSMS,
  sendDynamicOTP
};
