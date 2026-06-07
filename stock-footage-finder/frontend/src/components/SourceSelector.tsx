import React, { useState } from 'react';
import { ChevronDown, Check, Key } from 'lucide-react';
import { useApiKeyContext } from '../contexts/ApiKeyContext';
import { MEDIA_SOURCES } from '../../../shared/constants';

interface SourceSelectorProps {
  selectedSources: string[];
  onSourcesChange: (sources: string[]) => void;
  disabled?: boolean;
  showApiKeyStatus?: boolean;
  multiSelect?: boolean;
}

export function SourceSelector({
  selectedSources,
  onSourcesChange,
  disabled = false,
  showApiKeyStatus = true,
  multiSelect = true,
}: SourceSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { hasApiKey } = useApiKeyContext();

  const handleSourceToggle = (sourceName: string) => {
    if (disabled) return;

    if (multiSelect) {
      if (selectedSources.includes(sourceName)) {
        // Don't allow deselecting all sources
        if (selectedSources.length > 1) {
          onSourcesChange(selectedSources.filter(s => s !== sourceName));
        }
      } else {
        onSourcesChange([...selectedSources, sourceName]);
      }
    } else {
      // Single select mode
      onSourcesChange([sourceName]);
      setIsOpen(false);
    }
  };

  const handleSelectAll = () => {
    if (disabled) return;
    
    const availableSources = MEDIA_SOURCES.filter(source => 
      !source.apiKeyRequired || hasApiKey(source.name)
    );
    onSourcesChange(availableSources.map(s => s.name));
  };

  const handleDeselectAll = () => {
    if (disabled) return;
    
    // Keep at least one source selected
    const availableSources = MEDIA_SOURCES.filter(source => 
      !source.apiKeyRequired || hasApiKey(source.name)
    );
    if (availableSources.length > 0) {
      onSourcesChange([availableSources[0].name]);
    }
  };

  const getSelectedDisplay = () => {
    if (selectedSources.length === 0) {
      return 'Select sources';
    }

    if (selectedSources.length === 1) {
      const source = MEDIA_SOURCES.find(s => s.name === selectedSources[0]);
      return source?.displayName || selectedSources[0];
    }

    return `${selectedSources.length} sources selected`;
  };

  const availableSources = MEDIA_SOURCES.filter(source => 
    !source.apiKeyRequired || hasApiKey(source.name)
  );

  const hasApiKeyForSource = (sourceName: string): boolean => {
    return hasApiKey(sourceName);
  };

  return (
    <div className="source-selector">
      <div className="source-selector__trigger">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="source-selector__button"
          disabled={disabled}
        >
          <span className="source-selector__label">
            {getSelectedDisplay()}
          </span>
          <ChevronDown 
            size={16} 
            className={`source-selector__chevron ${isOpen ? 'source-selector__chevron--open' : ''}`}
          />
        </button>

        {showApiKeyStatus && (
          <div className="source-selector__status">
            {availableSources.length < MEDIA_SOURCES.length && (
              <div className="source-selector__status-warning">
                <Key size={12} />
                <span>API keys required for some sources</span>
              </div>
            )}
          </div>
        )}
      </div>

      {isOpen && (
        <div className="source-selector__dropdown">
          <div className="source-selector__header">
            <span className="source-selector__title">
              Media Sources
            </span>
            
            {multiSelect && (
              <div className="source-selector__actions">
                <button
                  type="button"
                  onClick={handleSelectAll}
                  className="source-selector__action"
                  disabled={disabled}
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={handleDeselectAll}
                  className="source-selector__action"
                  disabled={disabled}
                >
                  None
                </button>
              </div>
            )}
          </div>

          <div className="source-selector__list">
            {MEDIA_SOURCES.map(source => {
              const isSelected = selectedSources.includes(source.name);
              const isAvailable = !source.apiKeyRequired || hasApiKeyForSource(source.name);
              const needsApiKey = source.apiKeyRequired && !hasApiKeyForSource(source.name);

              return (
                <div
                  key={source.name}
                  className={`source-selector__item ${isSelected ? 'source-selector__item--selected' : ''} ${!isAvailable ? 'source-selector__item--disabled' : ''}`}
                >
                  <button
                    type="button"
                    onClick={() => handleSourceToggle(source.name)}
                    className="source-selector__item-button"
                    disabled={disabled || !isAvailable}
                  >
                    <div className="source-selector__item-content">
                      <div className="source-selector__item-info">
                        <span className="source-selector__item-name">
                          {source.displayName}
                        </span>
                        
                        <div className="source-selector__item-meta">
                          {!source.apiKeyRequired && (
                            <span className="source-selector__item-badge source-selector__item-badge--free">
                              Free
                            </span>
                          )}
                          
                          {needsApiKey && (
                            <span className="source-selector__item-badge source-selector__item-badge--key">
                              <Key size={10} />
                              API Key
                            </span>
                          )}
                        </div>
                      </div>

                      {isSelected && (
                        <Check size={16} className="source-selector__item-check" />
                      )}
                    </div>
                  </button>

                  {needsApiKey && (
                    <div className="source-selector__item-help">
                      <span>API key required</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {availableSources.length === 0 && (
            <div className="source-selector__empty">
              <Key size={24} />
              <p>No API keys configured</p>
              <p className="source-selector__empty-hint">
                Add API keys in settings to access media sources
              </p>
            </div>
          )}

          <div className="source-selector__footer">
            <div className="source-selector__stats">
              <span>
                {selectedSources.length} of {availableSources.length} available sources selected
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Overlay to close dropdown when clicking outside */}
      {isOpen && (
        <div 
          className="source-selector__overlay"
          onClick={() => setIsOpen(false)}
        />
      )}
    </div>
  );
}

export default SourceSelector;