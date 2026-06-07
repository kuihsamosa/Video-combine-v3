import React, { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { apiService } from '../services/apiService';
import { storageService } from '../services/storageService';
import type { ApiKeys } from '../types';

interface ApiKeyContextType {
  apiKeys: ApiKeys;
  isLoading: boolean;
  error: string | null;
  setApiKey: (source: string, apiKey: string) => Promise<void>;
  removeApiKey: (source: string) => Promise<void>;
  clearAllApiKeys: () => Promise<void>;
  hasApiKey: (source: string) => boolean;
  refreshApiKeys: () => Promise<void>;
}

const ApiKeyContext = createContext<ApiKeyContextType | undefined>(undefined);

interface ApiKeyProviderProps {
  children: ReactNode;
}

export function ApiKeyProvider({ children }: ApiKeyProviderProps) {
  const [apiKeys, setApiKeysState] = useState<ApiKeys>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load API keys on mount
  useEffect(() => {
    loadApiKeys();
  }, []);

  const loadApiKeys = async () => {
    try {
      setIsLoading(true);
      setError(null);
      
      // Try to load from backend first
      try {
        const backendApiKeys = await apiService.getApiKeys();
        setApiKeysState(backendApiKeys);
      } catch (backendError) {
        // Fallback to local storage if backend is not available
        console.warn('Backend not available, using local storage for API keys');
        const localApiKeys = storageService.getApiKeys();
        setApiKeysState(localApiKeys);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load API keys');
    } finally {
      setIsLoading(false);
    }
  };

  const setApiKey = async (source: string, apiKey: string) => {
    try {
      setError(null);
      
      // Update local state immediately for better UX
      const newApiKeys = { ...apiKeys, [source]: apiKey };
      setApiKeysState(newApiKeys);
      
      // Try to save to backend first
      try {
        await apiService.saveApiKeys(newApiKeys);
      } catch (backendError) {
        // Fallback to local storage if backend is not available
        console.warn('Backend not available, saving API key to local storage');
        storageService.setApiKey(source, apiKey);
      }
    } catch (err) {
      // Revert state on error
      const { [source]: removed, ...revertedApiKeys } = apiKeys as any;
      setApiKeysState(revertedApiKeys);
      
      setError(err instanceof Error ? err.message : 'Failed to save API key');
      throw err;
    }
  };

  const removeApiKey = async (source: string) => {
    try {
      setError(null);
      
      // Update local state immediately for better UX
      const { [source]: removed, ...newApiKeys } = apiKeys as any;
      setApiKeysState(newApiKeys);
      
      // Try to remove from backend first
      try {
        await apiService.deleteApiKey(source);
      } catch (backendError) {
        // Fallback to local storage if backend is not available
        console.warn('Backend not available, removing API key from local storage');
        storageService.removeApiKey(source);
      }
    } catch (err) {
      // Revert state on error
      setApiKeysState({ ...apiKeys });
      
      setError(err instanceof Error ? err.message : 'Failed to remove API key');
      throw err;
    }
  };

  const clearAllApiKeys = async () => {
    try {
      setError(null);
      
      // Update local state immediately for better UX
      setApiKeysState({});
      
      // Try to clear from backend first
      try {
        // This would need to be implemented in the backend
        // await apiService.clearAllApiKeys();
      } catch (backendError) {
        // Fallback to local storage if backend is not available
        console.warn('Backend not available, clearing API keys from local storage');
        storageService.clearApiKeys();
      }
    } catch (err) {
      // Revert state on error
      setApiKeysState({ ...apiKeys });
      
      setError(err instanceof Error ? err.message : 'Failed to clear API keys');
      throw err;
    }
  };

  const hasApiKey = (source: string): boolean => {
    return Boolean(apiKeys[source]);
  };

  const refreshApiKeys = async (): Promise<void> => {
    await loadApiKeys();
  };

  const contextValue: ApiKeyContextType = {
    apiKeys,
    isLoading,
    error,
    setApiKey,
    removeApiKey,
    clearAllApiKeys,
    hasApiKey,
    refreshApiKeys,
  };

  return (
    <ApiKeyContext.Provider value={contextValue}>
      {children}
    </ApiKeyContext.Provider>
  );
}

export function useApiKeyContext(): ApiKeyContextType {
  const context = useContext(ApiKeyContext);
  if (context === undefined) {
    throw new Error('useApiKeyContext must be used within an ApiKeyProvider');
  }
  return context;
}

export default ApiKeyContext;