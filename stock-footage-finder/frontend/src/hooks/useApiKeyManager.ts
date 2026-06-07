import { useState, useCallback } from 'react';
import { useApiKeyContext } from '../contexts/ApiKeyContext';
import { MEDIA_SOURCES } from '../../../shared/constants';
import type { ApiKeys, ApiError } from '../types';

interface UseApiKeyManagerState {
  isLoading: boolean;
  error: string | null;
  isDirty: boolean;
}

interface UseApiKeyManagerActions {
  saveApiKey: (source: string, apiKey: string) => Promise<void>;
  removeApiKey: (source: string) => Promise<void>;
  clearAllApiKeys: () => Promise<void>;
  validateApiKey: (source: string, apiKey: string) => Promise<boolean>;
  resetForm: () => void;
  hasUnsavedChanges: () => boolean;
}

export function useApiKeyManager(
  initialApiKeys?: ApiKeys
): UseApiKeyManagerState & UseApiKeyManagerActions & { apiKeys: ApiKeys } {
  const { 
    apiKeys: contextApiKeys, 
    isLoading: contextIsLoading, 
    error: contextError,
    setApiKey: contextSetApiKey,
    removeApiKey: contextRemoveApiKey,
    clearAllApiKeys: contextClearAllApiKeys,
    hasApiKey,
    refreshApiKeys
  } = useApiKeyContext();

  const [localApiKeys, setLocalApiKeys] = useState<ApiKeys>(initialApiKeys || contextApiKeys);
  const [isDirty, setIsDirty] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Update local state when context changes
  const updateLocalState = useCallback((newApiKeys: ApiKeys) => {
    setLocalApiKeys(newApiKeys);
    setIsDirty(false);
    setError(null);
  }, []);

  const saveApiKey = useCallback(async (source: string, apiKey: string) => {
    if (!apiKey.trim()) {
      setError('API key cannot be empty');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Validate API key format (basic validation)
      if (!validateApiKeyFormat(source, apiKey)) {
        throw new Error(`Invalid API key format for ${source}`);
      }

      // Update local state immediately for better UX
      const newApiKeys = { ...localApiKeys, [source]: apiKey };
      setLocalApiKeys(newApiKeys);
      setIsDirty(true);

      // Save to context (which handles backend/local storage)
      await contextSetApiKey(source, apiKey);
      
      // Mark as clean after successful save
      setIsDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save API key');
      
      // Revert local state on error
      const revertedApiKeys = { ...localApiKeys };
      delete revertedApiKeys[source as keyof typeof revertedApiKeys];
      setLocalApiKeys(revertedApiKeys);
      setIsDirty(false);
      
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [localApiKeys, contextSetApiKey]);

  const removeApiKey = useCallback(async (source: string) => {
    setIsLoading(true);
    setError(null);

    try {
      // Update local state immediately for better UX
      const newApiKeys = { ...localApiKeys };
      delete newApiKeys[source as keyof typeof newApiKeys];
      setLocalApiKeys(newApiKeys);
      setIsDirty(true);

      // Remove from context (which handles backend/local storage)
      await contextRemoveApiKey(source);
      
      // Mark as clean after successful removal
      setIsDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove API key');
      
      // Revert local state on error
      setLocalApiKeys(localApiKeys);
      setIsDirty(false);
      
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [localApiKeys, contextRemoveApiKey]);

  const clearAllApiKeys = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Update local state immediately for better UX
      setLocalApiKeys({});
      setIsDirty(true);

      // Clear from context (which handles backend/local storage)
      await contextClearAllApiKeys();
      
      // Mark as clean after successful clear
      setIsDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear API keys');
      
      // Revert local state on error
      setLocalApiKeys(localApiKeys);
      setIsDirty(false);
      
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [localApiKeys, contextClearAllApiKeys]);

  const validateApiKey = useCallback(async (source: string, apiKey: string): Promise<boolean> => {
    if (!apiKey.trim()) {
      return false;
    }

    // Basic format validation
    if (!validateApiKeyFormat(source, apiKey)) {
      return false;
    }

    // TODO: Implement actual API key validation by making a test request
    // This would depend on the specific API requirements for each source
    try {
      // For now, just return true for valid format
      return true;
    } catch (error) {
      return false;
    }
  }, []);

  const resetForm = useCallback(() => {
    setLocalApiKeys(contextApiKeys);
    setIsDirty(false);
    setError(null);
  }, [contextApiKeys]);

  const hasUnsavedChanges = useCallback((): boolean => {
    return isDirty;
  }, [isDirty]);

  // Basic API key format validation
  const validateApiKeyFormat = (_source: string, apiKey: string): boolean => {
    return apiKey.trim().length > 0;
  };

  return {
    apiKeys: localApiKeys,
    isLoading: isLoading || contextIsLoading,
    error: error || contextError,
    isDirty,
    saveApiKey,
    removeApiKey,
    clearAllApiKeys,
    validateApiKey,
    resetForm,
    hasUnsavedChanges,
  };
}

// Helper function to get source display name
export function getSourceDisplayName(sourceName: string): string {
  const source = MEDIA_SOURCES.find(s => s.name === sourceName);
  return source?.displayName || sourceName;
}

// Helper function to check if source requires API key
export function sourceRequiresApiKey(sourceName: string): boolean {
  const source = MEDIA_SOURCES.find(s => s.name === sourceName);
  return source?.apiKeyRequired ?? true;
}

// Helper function to get all available sources
export function getAvailableSources(): typeof MEDIA_SOURCES {
  return MEDIA_SOURCES;
}

// Helper function to get sources that require API keys
export function getSourcesRequiringApiKeys(): typeof MEDIA_SOURCES {
  return MEDIA_SOURCES.filter(source => source.apiKeyRequired);
}