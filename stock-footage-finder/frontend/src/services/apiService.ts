import axios from 'axios';
import type { AxiosInstance, AxiosResponse } from 'axios';
import { API_ENDPOINTS } from '../../../shared/constants';
import type { 
  ApiResponse, 
  ApiError, 
  SearchResult, 
  SearchParams, 
  ApiKeys, 
  AppSettings 
} from '../types';

class ApiService {
  private api: AxiosInstance;

  constructor() {
    this.api = axios.create({
      baseURL: API_ENDPOINTS.backend,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Request interceptor
    this.api.interceptors.request.use(
      (config) => {
        // Add any global request logic here
        return config;
      },
      (error) => {
        return Promise.reject(error);
      }
    );

    // Response interceptor
    this.api.interceptors.response.use(
      (response: AxiosResponse) => {
        return response;
      },
      (error) => {
        const apiError: ApiError = {
          message: error.response?.data?.message || error.message || 'An unknown error occurred',
          status: error.response?.status,
          code: error.response?.data?.code,
        };
        return Promise.reject(apiError);
      }
    );
  }

  // Health check
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.api.get(API_ENDPOINTS.health);
      return response.status === 200;
    } catch (error) {
      return false;
    }
  }

  // Search media
  async searchMedia(searchParams: SearchParams): Promise<SearchResult[]> {
    try {
      const response = await this.api.get<ApiResponse<any>>('/api/search', { params: searchParams });
      // Handle the response structure from backend
      if (response.data && response.data.results) {
        // If response has the expected structure with results array
        return response.data.results;
      } else if (response.data && Array.isArray(response.data)) {
        // If response is directly an array of results
        return response.data;
      } else {
        // Fallback for unexpected response structure
        console.warn('Unexpected response structure:', response.data);
        return [];
      }
    } catch (error) {
      throw error;
    }
  }

  // Search specific source
  async searchSource(source: string, searchParams: SearchParams): Promise<SearchResult> {
    try {
      const endpoint = API_ENDPOINTS.search[source as keyof typeof API_ENDPOINTS.search];
      if (!endpoint) {
        throw new Error(`Unknown source: ${source}`);
      }
      
      const response = await this.api.post<ApiResponse<SearchResult>>(endpoint, searchParams);
      return response.data.data;
    } catch (error) {
      throw error;
    }
  }

  // Get available sources
  async getSources(): Promise<any[]> {
    try {
      const response = await this.api.get<ApiResponse<any[]>>('/api/sources');
      return response.data.data;
    } catch (error) {
      throw error;
    }
  }

  // API Key management
  async saveApiKeys(apiKeys: ApiKeys): Promise<void> {
    try {
      await this.api.post('/api/keys', apiKeys);
    } catch (error) {
      throw error;
    }
  }

  async getApiKeys(): Promise<ApiKeys> {
    try {
      const response = await this.api.get<ApiResponse<ApiKeys>>('/api/keys');
      return response.data.data;
    } catch (error) {
      throw error;
    }
  }

  async deleteApiKey(source: string): Promise<void> {
    try {
      await this.api.delete(`/api/keys/${source}`);
    } catch (error) {
      throw error;
    }
  }

  // Settings management
  async saveSettings(settings: AppSettings): Promise<void> {
    try {
      await this.api.post('/api/settings', settings);
    } catch (error) {
      throw error;
    }
  }

  async getSettings(): Promise<AppSettings> {
    try {
      const response = await this.api.get<ApiResponse<AppSettings>>('/api/settings');
      return response.data.data;
    } catch (error) {
      throw error;
    }
  }

  // Download media
  async getDownloadUrl(mediaId: string, source: string): Promise<string> {
    try {
      const response = await this.api.post<ApiResponse<{ downloadUrl: string }>>('/api/download', {
        mediaId,
        source,
      });
      return response.data.data.downloadUrl;
    } catch (error) {
      throw error;
    }
  }
}

export const apiService = new ApiService();
export default apiService;