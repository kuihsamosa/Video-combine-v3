import type { SearchHistoryItem, FavoriteItem, AppSettings } from '../types';

class StorageService {
  private readonly keys = {
    SEARCH_HISTORY: 'stock_footage_finder_search_history',
    FAVORITES: 'stock_footage_finder_favorites',
    SETTINGS: 'stock_footage_finder_settings',
    API_KEYS: 'stock_footage_finder_api_keys',
  };

  // Search History
  getSearchHistory(): SearchHistoryItem[] {
    try {
      const history = localStorage.getItem(this.keys.SEARCH_HISTORY);
      return history ? JSON.parse(history) : [];
    } catch (error) {
      console.error('Error reading search history:', error);
      return [];
    }
  }

  saveSearchHistory(history: SearchHistoryItem[]): void {
    try {
      localStorage.setItem(this.keys.SEARCH_HISTORY, JSON.stringify(history));
    } catch (error) {
      console.error('Error saving search history:', error);
    }
  }

  addSearchHistoryItem(item: SearchHistoryItem): void {
    const history = this.getSearchHistory();
    
    // Remove any existing entry with the same query
    const filteredHistory = history.filter(h => h.query !== item.query);
    
    // Add the new item at the beginning
    filteredHistory.unshift(item);
    
    // Keep only the last 50 items
    const limitedHistory = filteredHistory.slice(0, 50);
    
    this.saveSearchHistory(limitedHistory);
  }

  clearSearchHistory(): void {
    try {
      localStorage.removeItem(this.keys.SEARCH_HISTORY);
    } catch (error) {
      console.error('Error clearing search history:', error);
    }
  }

  // Favorites
  getFavorites(): FavoriteItem[] {
    try {
      const favorites = localStorage.getItem(this.keys.FAVORITES);
      return favorites ? JSON.parse(favorites) : [];
    } catch (error) {
      console.error('Error reading favorites:', error);
      return [];
    }
  }

  saveFavorites(favorites: FavoriteItem[]): void {
    try {
      localStorage.setItem(this.keys.FAVORITES, JSON.stringify(favorites));
    } catch (error) {
      console.error('Error saving favorites:', error);
    }
  }

  addFavorite(mediaItem: FavoriteItem['mediaItem'], tags?: string[]): void {
    const favorites = this.getFavorites();
    
    // Check if already in favorites
    if (favorites.some(f => f.mediaItem.id === mediaItem.id)) {
      return;
    }
    
    const newFavorite: FavoriteItem = {
      mediaItem,
      addedAt: new Date(),
      tags,
    };
    
    favorites.push(newFavorite);
    this.saveFavorites(favorites);
  }

  removeFavorite(mediaId: string): void {
    const favorites = this.getFavorites();
    const filteredFavorites = favorites.filter(f => f.mediaItem.id !== mediaId);
    this.saveFavorites(filteredFavorites);
  }

  isFavorite(mediaId: string): boolean {
    const favorites = this.getFavorites();
    return favorites.some(f => f.mediaItem.id === mediaId);
  }

  updateFavoriteTags(mediaId: string, tags: string[]): void {
    const favorites = this.getFavorites();
    const favorite = favorites.find(f => f.mediaItem.id === mediaId);
    
    if (favorite) {
      favorite.tags = tags;
      this.saveFavorites(favorites);
    }
  }

  clearFavorites(): void {
    try {
      localStorage.removeItem(this.keys.FAVORITES);
    } catch (error) {
      console.error('Error clearing favorites:', error);
    }
  }

  // Settings
  getSettings(): AppSettings | null {
    try {
      const settings = localStorage.getItem(this.keys.SETTINGS);
      return settings ? JSON.parse(settings) : null;
    } catch (error) {
      console.error('Error reading settings:', error);
      return null;
    }
  }

  saveSettings(settings: AppSettings): void {
    try {
      localStorage.setItem(this.keys.SETTINGS, JSON.stringify(settings));
    } catch (error) {
      console.error('Error saving settings:', error);
    }
  }

  // API Keys (stored separately for security)
  getApiKeys(): Record<string, string> {
    try {
      const apiKeys = localStorage.getItem(this.keys.API_KEYS);
      return apiKeys ? JSON.parse(apiKeys) : {};
    } catch (error) {
      console.error('Error reading API keys:', error);
      return {};
    }
  }

  saveApiKeys(apiKeys: Record<string, string>): void {
    try {
      localStorage.setItem(this.keys.API_KEYS, JSON.stringify(apiKeys));
    } catch (error) {
      console.error('Error saving API keys:', error);
    }
  }

  setApiKey(source: string, apiKey: string): void {
    const apiKeys = this.getApiKeys();
    apiKeys[source] = apiKey;
    this.saveApiKeys(apiKeys);
  }

  removeApiKey(source: string): void {
    const apiKeys = this.getApiKeys();
    delete apiKeys[source];
    this.saveApiKeys(apiKeys);
  }

  clearApiKeys(): void {
    try {
      localStorage.removeItem(this.keys.API_KEYS);
    } catch (error) {
      console.error('Error clearing API keys:', error);
    }
  }

  // Utility methods
  exportData(): string {
    const data = {
      searchHistory: this.getSearchHistory(),
      favorites: this.getFavorites(),
      settings: this.getSettings(),
      // Note: API keys are not exported for security reasons
    };
    
    return JSON.stringify(data, null, 2);
  }

  importData(jsonData: string): { success: boolean; message: string } {
    try {
      const data = JSON.parse(jsonData);
      
      if (data.searchHistory && Array.isArray(data.searchHistory)) {
        this.saveSearchHistory(data.searchHistory);
      }
      
      if (data.favorites && Array.isArray(data.favorites)) {
        this.saveFavorites(data.favorites);
      }
      
      if (data.settings && typeof data.settings === 'object') {
        this.saveSettings(data.settings);
      }
      
      return { success: true, message: 'Data imported successfully' };
    } catch (error) {
      return { 
        success: false, 
        message: error instanceof Error ? error.message : 'Invalid data format' 
      };
    }
  }

  clearAllData(): void {
    this.clearSearchHistory();
    this.clearFavorites();
    this.clearApiKeys();
    
    try {
      localStorage.removeItem(this.keys.SETTINGS);
    } catch (error) {
      console.error('Error clearing settings:', error);
    }
  }
}

export const storageService = new StorageService();
export default storageService;