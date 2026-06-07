import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Key, 
  Eye, 
  EyeOff, 
  Check, 
  X, 
  AlertCircle, 
  ExternalLink,
  Copy,
  Trash2
} from 'lucide-react';
import { useApiKeyManager, getSourceDisplayName, sourceRequiresApiKey } from '../hooks/useApiKeyManager';
import { MEDIA_SOURCES } from '../../../shared/constants';

interface ApiKeyManagerProps {
  onSave?: () => void;
  compact?: boolean;
  showValidation?: boolean;
}

export function ApiKeyManager({
  onSave,
  compact = false,
  showValidation = true,
}: ApiKeyManagerProps) {
  const {
    apiKeys,
    isLoading,
    error,
    isDirty,
    saveApiKey,
    removeApiKey,
    clearAllApiKeys,
    validateApiKey,
    resetForm,
    hasUnsavedChanges,
  } = useApiKeyManager();

  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());
  const [validationResults, setValidationResults] = useState<Record<string, boolean>>({});
  const [isValidating, setIsValidating] = useState<Record<string, boolean>>({});
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [successStates, setSuccessStates] = useState<Record<string, boolean>>({});
  const successTimeouts = useRef<Record<string, number>>({});

  const sourcesRequiringKeys = useMemo(
    () => MEDIA_SOURCES.filter(source => sourceRequiresApiKey(source.name)),
    []
  );

  useEffect(() => {
    setFormValues(apiKeys as Record<string, string>);
  }, [apiKeys]);

  useEffect(() => {
    return () => {
      Object.values(successTimeouts.current).forEach(timeoutId => {
        if (timeoutId) {
          window.clearTimeout(timeoutId);
        }
      });
    };
  }, []);

  const toggleKeyVisibility = (source: string) => {
    setVisibleKeys(prev => {
      const newSet = new Set(prev);
      if (newSet.has(source)) {
        newSet.delete(source);
      } else {
        newSet.add(source);
      }
      return newSet;
    });
  };

  const clearSuccessState = (source: string) => {
    if (successTimeouts.current[source]) {
      window.clearTimeout(successTimeouts.current[source]);
    }
    successTimeouts.current[source] = window.setTimeout(() => {
      setSuccessStates(prev => {
        const next = { ...prev };
        delete next[source];
        return next;
      });
      delete successTimeouts.current[source];
    }, 2500);
  };

  const handleApiKeyChange = async (source: string, value: string) => {
    setFormValues(prev => ({ ...prev, [source]: value }));
    setSuccessStates(prev => {
      const next = { ...prev };
      delete next[source];
      return next;
    });

    setValidationResults(prev => {
      const newResults = { ...prev };
      delete newResults[source];
      return newResults;
    });
    
    if (showValidation && value.trim()) {
      setIsValidating(prev => ({ ...prev, [source]: true }));
      
      try {
        const isValid = await validateApiKey(source, value);
        setValidationResults(prev => ({ ...prev, [source]: isValid }));
      } catch (error) {
        setValidationResults(prev => ({ ...prev, [source]: false }));
      } finally {
        setIsValidating(prev => ({ ...prev, [source]: false }));
      }
    }
  };

  const handleSaveKey = async (source: string, value: string) => {
    const trimmedValue = value.trim();
    if (!trimmedValue) {
      return;
    }

    try {
      await saveApiKey(source, trimmedValue);
      setFormValues(prev => ({ ...prev, [source]: trimmedValue }));
      setSuccessStates(prev => ({ ...prev, [source]: true }));
      clearSuccessState(source);
      if (onSave) {
        onSave();
      }
    } catch (error) {
      // Error is handled by the hook
    }
  };

  const handleRemoveKey = async (source: string) => {
    try {
      await removeApiKey(source);
      setVisibleKeys(prev => {
        const newSet = new Set(prev);
        newSet.delete(source);
        return newSet;
      });
      setValidationResults(prev => {
        const newResults = { ...prev };
        delete newResults[source];
        return newResults;
      });
      setFormValues(prev => {
        const next = { ...prev };
        delete next[source];
        return next;
      });
      setSuccessStates(prev => {
        const next = { ...prev };
        delete next[source];
        return next;
      });
    } catch (error) {
      // Error is handled by the hook
    }
  };

  const handleClearAll = async () => {
    if (!confirm('Are you sure you want to remove all API keys? This action cannot be undone.')) {
      return;
    }

    try {
      await clearAllApiKeys();
      setVisibleKeys(new Set());
      setValidationResults({});
    } catch (error) {
      // Error is handled by the hook
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      // Could show a toast notification here
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  };

  const getApiKeyDocumentationUrl = (source: string): string => {
    const urls: Record<string, string> = {
      pexels: 'https://www.pexels.com/api/',
      pixabay: 'https://pixabay.com/api/docs/',
      unsplash: 'https://unsplash.com/developers',
      videvo: 'https://www.videvo.net/api/',
      coverr: 'https://coverr.co/api',
    };
    return urls[source] || '#';
  };

  const getValidationStatus = (source: string) => {
    if (!showValidation) return null;
    
    if (isValidating[source]) {
      return { status: 'validating', message: 'Validating...' };
    }
    
    if (validationResults[source] === true) {
      return { status: 'valid', message: 'Valid API key' };
    }
    
    if (validationResults[source] === false) {
      return { status: 'invalid', message: 'Invalid API key' };
    }
    
    return null;
  };

  const renderCompactView = () => (
    <div className="api-key-manager--compact">
      <div className="api-key-manager__summary">
        <span className="api-key-manager__count">
          {Object.keys(apiKeys).length} API key{Object.keys(apiKeys).length !== 1 ? 's' : ''} configured
        </span>
        
        {isDirty && (
          <span className="api-key-manager__dirty-indicator">
            Unsaved changes
          </span>
        )}
      </div>
      
      <button
        onClick={() => {/* Expand to full view */}}
        className="api-key-manager__expand-button"
      >
        Manage API Keys
      </button>
    </div>
  );

  const renderFullView = () => (
    <div className="api-key-manager">
      {/* Header */}
      <div className="api-key-manager__header">
        <h3 className="api-key-manager__title">
          <Key size={20} />
          API Key Management
        </h3>
        
        <div className="api-key-manager__actions">
          {hasUnsavedChanges() && (
            <button
              onClick={resetForm}
              className="api-key-manager__action-button api-key-manager__action-button--reset"
              disabled={isLoading}
            >
              Reset
            </button>
          )}
          
          {Object.keys(apiKeys).length > 0 && (
            <button
              onClick={handleClearAll}
              className="api-key-manager__action-button api-key-manager__action-button--clear"
              disabled={isLoading}
            >
              <Trash2 size={16} />
              Clear All
            </button>
          )}
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="api-key-manager__error">
          <AlertCircle size={16} />
          <span>{error}</span>
          <button
            onClick={() => {/* Clear error */}}
            className="api-key-manager__error-close"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* API Keys List */}
      <div className="api-key-manager__list">
        {sourcesRequiringKeys.map(source => {
          const hasKey = Boolean((apiKeys as any)[source.name]);
          const isVisible = visibleKeys.has(source.name);
          const validationStatus = getValidationStatus(source.name);
          const keyValue = formValues[source.name] ?? '';

          return (
            <div
              key={source.name}
              className={`api-key-manager__item ${hasKey ? 'api-key-manager__item--has-key' : ''}`}
            >
              <div className="api-key-manager__item-header">
                <div className="api-key-manager__source-info">
                  <h4 className="api-key-manager__source-name">
                    {source.displayName}
                  </h4>
                  
                  <div className="api-key-manager__source-meta">
                    {hasKey && (
                      <span className="api-key-manager__status api-key-manager__status--configured">
                        <Check size={12} />
                        Configured
                      </span>
                    )}
                    
                    {validationStatus && (
                      <span className={`api-key-manager__validation api-key-manager__validation--${validationStatus.status}`}>
                        {validationStatus.message}
                      </span>
                    )}
                  </div>
                </div>

                <div className="api-key-manager__item-actions">
                  <a
                    href={getApiKeyDocumentationUrl(source.name)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="api-key-manager__help-link"
                    aria-label="Get API key documentation"
                  >
                    <ExternalLink size={14} />
                  </a>
                </div>
              </div>

              <div className="api-key-manager__input-group">
                <div className="api-key-manager__input-wrapper">
                  <input
                    type={isVisible ? 'text' : 'password'}
                    value={keyValue}
                    onChange={(e) => handleApiKeyChange(source.name, e.target.value)}
                    placeholder={`Enter ${source.displayName} API key`}
                    className="api-key-manager__input"
                    disabled={isLoading}
                  />
                  
                  {keyValue && (
                    <button
                      type="button"
                      onClick={() => toggleKeyVisibility(source.name)}
                      className="api-key-manager__visibility-toggle"
                      aria-label={isVisible ? 'Hide API key' : 'Show API key'}
                    >
                      {isVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  )}
                  
                  {keyValue && (
                    <button
                      type="button"
                      onClick={() => copyToClipboard(keyValue)}
                      className="api-key-manager__copy-button"
                      aria-label="Copy API key"
                    >
                      <Copy size={16} />
                    </button>
                  )}
                </div>

                <div className="api-key-manager__button-group">
                  <button
                    onClick={() => handleSaveKey(source.name, keyValue)}
                    className="api-key-manager__save-button"
                    disabled={isLoading || !keyValue.trim()}
                  >
                    {successStates[source.name] ? (
                      <span className="api-key-manager__save-success">
                        <Check size={14} /> Saved
                      </span>
                    ) : isLoading ? (
                      'Saving...'
                    ) : (
                      'Save'
                    )}
                  </button>
                  
                  {hasKey && (
                    <button
                      onClick={() => handleRemoveKey(source.name)}
                      className="api-key-manager__remove-button"
                      disabled={isLoading}
                    >
                      <Trash2 size={14} />
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Help Section */}
      <div className="api-key-manager__help">
        <h4 className="api-key-manager__help-title">
          Need help with API keys?
        </h4>
        <p className="api-key-manager__help-text">
          API keys are required to access premium media sources. Visit the documentation links above to learn how to obtain API keys for each service.
        </p>
        <div className="api-key-manager__security-note">
          <AlertCircle size={16} />
          <span>
            Your API keys are stored securely and are only used to make requests to the respective media services.
          </span>
        </div>
      </div>
    </div>
  );

  return compact ? renderCompactView() : renderFullView();
}

export default ApiKeyManager;