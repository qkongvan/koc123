
import { GoogleGenAI } from "@google/genai";
import { decryptKey } from "../utils/crypto";

const TEXT_STORAGE_KEY = 'koc_studio_text_api_keys';
const IMAGE_STORAGE_KEY = 'koc_studio_image_api_keys';
const TEXT_INDEX_KEY = 'koc_studio_current_text_key_index';
const IMAGE_INDEX_KEY = 'koc_studio_current_image_key_index';

export const getStoredKeys = (type: 'text' | 'image' = 'text'): string[] => {
  const storageKey = type === 'text' ? TEXT_STORAGE_KEY : IMAGE_STORAGE_KEY;
  const saved = localStorage.getItem(storageKey);
  if (!saved) return [];
  return saved.split('\n').map(k => k.trim()).filter(k => k.length > 0);
};

export const saveStoredKeys = (keysString: string, type: 'text' | 'image' = 'text') => {
  const storageKey = type === 'text' ? TEXT_STORAGE_KEY : IMAGE_STORAGE_KEY;
  localStorage.setItem(storageKey, keysString);
};

export const callWithRetry = async (fn: () => Promise<any>, retries = 2, delay = 4000) => {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      if (e.message?.includes("429") && i < retries) {
        console.warn(`Quota exceeded, retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
};

export const getAiClient = (type: 'text' | 'image' = 'text'): GoogleGenAI => {
  const keys = getStoredKeys(type);
  const indexKey = type === 'text' ? TEXT_INDEX_KEY : IMAGE_INDEX_KEY;
  
  let apiKey = '';
  
  if (keys.length === 0) {
    // Fallback về process.env.GEMINI_API_KEY nếu không có key thủ công
    // Sử dụng process.env.GEMINI_API_KEY theo spec, fallback về process.env.API_KEY
    apiKey = (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();
    
    if (!apiKey) {
      console.error(`[KeyService] No API Key found in storage or environment for ${type.toUpperCase()}`);
      throw new Error("API Key chưa được cấu hình. Vui lòng nhấp vào biểu tượng 'Cấu hình API Key' ở thanh menu (biểu tượng chìa khóa/khóa) để nhập danh sách API Key.");
    }
    
    console.debug(`[KeyService] Using environment API Key for ${type.toUpperCase()}`);
    return new GoogleGenAI({ apiKey });
  }

  // Lấy index hiện tại từ sessionStorage để xoay vòng trong phiên làm việc
  let currentIndex = parseInt(sessionStorage.getItem(indexKey) || '0');
  if (currentIndex >= keys.length) currentIndex = 0;

  // Giải mã key trước khi sử dụng (nếu nó được mã hóa)
  apiKey = decryptKey(keys[currentIndex]);

  // Tăng index cho lần gọi tiếp theo
  sessionStorage.setItem(indexKey, ((currentIndex + 1) % keys.length).toString());

  console.debug(`[KeyService] Using ${type.toUpperCase()} API Key #${currentIndex + 1} of ${keys.length} (Decrypted: ${apiKey.startsWith('AIza')})`);
  
  if (!apiKey) {
    throw new Error("API Key trong danh sách không hợp lệ. Vui lòng kiểm tra lại cấu hình API Key.");
  }

  return new GoogleGenAI({ apiKey });
};

export const callWithAiFallback = async <T>(task: (ai: any) => Promise<T>): Promise<T> => {
  try {
    return await task(getAiClient('text'));
  } catch (error) {
    console.warn("[KeyService] API 1 (Text) failed, trying API 2 (Image) as fallback...", error);
    try {
      return await task(getAiClient('image'));
    } catch (error2) {
      console.error("[KeyService] Both API 1 and API 2 failed:", error2);
      throw error2;
    }
  }
};

export const testApiKey = async (apiKey: string, type: 'text' | 'image'): Promise<{ success: boolean; error?: string }> => {
  if (!apiKey) return { success: false, error: "API Key trống" };
  const decryptedKey = decryptKey(apiKey.trim());
  const genAI = new GoogleGenAI({ apiKey: decryptedKey });
  
  const tryModel = async (modelId: string) => {
    return await genAI.models.generateContent({ 
      model: modelId,
      contents: { parts: [{ text: 'Hi' }] }
    });
  };

  try {
    // Thử model chính trước
    try {
      await tryModel("gemini-3-flash-preview");
    } catch (e: any) {
      // Nếu server bận (503), đợi 2 giây rồi thử lại model chính
      if (e.message?.includes("503") || e.message?.includes("UNAVAILABLE")) {
        console.warn(`[KeyService] Primary model busy, retrying in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        try {
          await tryModel("gemini-3-flash-preview");
        } catch (e2: any) {
          // Nếu vẫn bận, thử model fallback 1
          console.warn(`[KeyService] Primary model still busy, trying fallback 1 (1.5-flash)...`);
          try {
            await tryModel("gemini-1.5-flash");
          } catch (e3: any) {
            // Nếu vẫn bận, thử model fallback 2 (1.5-flash-8b - nhẹ hơn, thường sẵn sàng hơn)
            console.warn(`[KeyService] Fallback 1 busy, trying fallback 2 (1.5-flash-8b)...`);
            try {
              await tryModel("gemini-1.5-flash-8b");
            } catch (e4: any) {
              // Nếu tất cả đều lỗi, ném lại lỗi 503 ban đầu
              throw e;
            }
          }
        }
      } else {
        throw e;
      }
    }
    return { success: true };
  } catch (e: any) {
    console.error(`[KeyService] Test API Key ${type} failed:`, e);
    let errorMsg = e.message || "Lỗi không xác định";
    
    // Cải thiện việc parse lỗi JSON (có thể có khoảng trắng hoặc ký tự lạ)
    try {
      const jsonMatch = errorMsg.match(/\{.*\}/s);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.error?.message) {
          errorMsg = parsed.error.message;
        }
      }
    } catch (parseErr) {
      // Bỏ qua nếu không parse được
    }

    if (errorMsg.includes("API_KEY_INVALID")) errorMsg = "API Key không hợp lệ";
    else if (errorMsg.includes("429")) errorMsg = "Hết hạn mức (Quota exceeded)";
    else if (errorMsg.includes("404")) errorMsg = "Model không tìm thấy hoặc API chưa hỗ trợ model này";
    else if (errorMsg.includes("503") || errorMsg.includes("UNAVAILABLE")) errorMsg = "Server đang bận (High demand). Vui lòng thử lại sau vài giây.";
    
    return { success: false, error: errorMsg };
  }
};
