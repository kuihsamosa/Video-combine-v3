import React, { useState, useEffect } from 'react';
import { Search, Filter, X } from 'lucide-react';
import { useApiKeyContext } from '../contexts/ApiKeyContext';
import { MEDIA_SOURCES, DEFAULT_SETTINGS } from '../../../shared/constants';
import type { SearchParams, FilterOptions } from '../types';

const DEFAULT_FILTERS: FilterOptions = Object.freeze({
  mediaType: 'all',
  orientation: 'all',
});

const areArraysEqual = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const areFiltersEqual = (a: FilterOptions, b: FilterOptions) => {
  if (a.mediaType !== b.mediaType || a.orientation !== b.orientation) {
    return false;
  }

  const aDuration = a.duration ?? {};
  const bDuration = b.duration ?? {};
  if (aDuration.min !== bDuration.min || aDuration.max !== bDuration.max) {
    return false;
  }

  const aSize = a.size ?? {};
  const bSize = b.size ?? {};
  if (aSize.min !== bSize.min || aSize.max !== bSize.max) {
    return false;
  }

  return true;
};

interface SearchFormProps {
  onSearch: (params: SearchParams) => void;
  isLoading?: boolean;
  initialQuery?: string;
  initialSources?: string[];
  initialFilters?: FilterOptions;
}

export function SearchForm({
  onSearch,
  isLoading = false,
  initialQuery = '',
  initialSources = DEFAULT_SETTINGS.defaultSources,
  initialFilters = DEFAULT_FILTERS,
}: SearchFormProps) {
  const { hasApiKey } = useApiKeyContext();
  const [query, setQuery] = useState(initialQuery);
  const [selectedSources, setSelectedSources] = useState<string[]>(initialSources);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<FilterOptions>(initialFilters);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Filter sources that have API keys
  const availableSources = MEDIA_SOURCES.filter(source => 
    !source.apiKeyRequired || hasApiKey(source.name)
  );

  useEffect(() => {
    setSelectedSources(prev =>
      areArraysEqual(prev, initialSources) ? prev : initialSources,
    );
  }, [initialSources]);

  useEffect(() => {
    setFilters(prev => (areFiltersEqual(prev, initialFilters) ? prev : initialFilters));
  }, [initialFilters]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!query.trim()) {
      return;
    }

    const searchParams: SearchParams = {
      query: query.trim(),
      sources: selectedSources,
      mediaType: filters.mediaType,
      orientation: filters.orientation,
      perPage: DEFAULT_SETTINGS.defaultPerPage,
      page: 1,
    };

    onSearch(searchParams);
    setShowSuggestions(false);
  };

  const handleSourceToggle = (sourceName: string) => {
    setSelectedSources(prev => {
      if (prev.includes(sourceName)) {
        // Don't allow deselecting all sources
        if (prev.length > 1) {
          return prev.filter(s => s !== sourceName);
        }
        return prev;
      } else {
        return [...prev, sourceName];
      }
    });
  };

  const handleFilterChange = (filterName: keyof FilterOptions, value: any) => {
    setFilters(prev => ({
      ...prev,
      [filterName]: value,
    }));
  };

  const clearFilters = () => {
    setFilters({
      mediaType: 'all',
      orientation: 'all',
      duration: undefined,
      size: undefined,
    });
  };

  const selectAllSources = () => {
    const allSourceNames = availableSources.map(s => s.name);
    setSelectedSources(allSourceNames);
  };

  const deselectAllSources = () => {
    // Keep at least one source selected
    setSelectedSources([availableSources[0]?.name || '']);
  };

  const handleQueryChange = (value: string) => {
    setQuery(value);
    
    // Generate suggestions (simple implementation)
    if (value.length > 2) {
      // This could be enhanced with actual search suggestions from the backend
      const mockSuggestions = [
        `${value} nature`,
        `${value} landscape`,
        `${value} city`,
        `${value} people`,
        `${value} technology`,
      ].slice(0, 5);
      setSuggestions(mockSuggestions);
      setShowSuggestions(true);
    } else {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  };

  const selectSuggestion = (suggestion: string) => {
    setQuery(suggestion);
    setSuggestions([]);
    setShowSuggestions(false);
  };

  return (
    <div className="search-form">
      <form onSubmit={handleSubmit} className="search-form__main">
        <div className="search-form__input-wrapper">
          <div className="search-form__input-container">
            <Search className="search-form__search-icon" size={20} />
            <input
              type="text"
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              placeholder="Search for stock footage and images..."
              className="search-form__input"
              disabled={isLoading}
              autoFocus
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="search-form__clear-button"
                disabled={isLoading}
              >
                <X size={16} />
              </button>
            )}
          </div>
          
          {showSuggestions && suggestions.length > 0 && (
            <div className="search-form__suggestions">
              {suggestions.map((suggestion, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => selectSuggestion(suggestion)}
                  className="search-form__suggestion"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="submit"
          disabled={isLoading || !query.trim() || selectedSources.length === 0}
          className={`search-form__submit-button ${isLoading ? 'search-form__submit-button--loading' : ''}`}
          aria-busy={isLoading}
        >
          {isLoading ? (
            <span className="search-form__loading" aria-live="polite">
              <span className="spinner spinner--small" aria-hidden="true" />
              <span>Searching...</span>
            </span>
          ) : (
            'Search'
          )}
        </button>
      </form>

      <div className="search-form__controls">
        <div className="search-form__sources">
          <div className="search-form__sources-header">
            <span>Sources:</span>
            <div className="search-form__source-actions">
              <button
                type="button"
                onClick={selectAllSources}
                className="search-form__source-action"
                disabled={isLoading}
              >
                All
              </button>
              <button
                type="button"
                onClick={deselectAllSources}
                className="search-form__source-action"
                disabled={isLoading}
              >
                None
              </button>
            </div>
          </div>
          <div className="search-form__source-list">
            {availableSources.map(source => (
              <label
                key={source.name}
                className="search-form__source-label"
              >
                <input
                  type="checkbox"
                  checked={selectedSources.includes(source.name)}
                  onChange={() => handleSourceToggle(source.name)}
                  disabled={isLoading}
                />
                <span className="search-form__source-name">
                  {source.displayName}
                  {!source.apiKeyRequired && (
                    <span className="search-form__source-badge">Free</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="search-form__filters-section">
          <button
            type="button"
            onClick={() => setShowFilters(!showFilters)}
            className="search-form__filters-toggle"
            disabled={isLoading}
          >
            <Filter size={16} />
            Filters
            {(filters.mediaType !== 'all' || 
              filters.orientation !== 'all' || 
              filters.duration || 
              filters.size) && (
              <span className="search-form__filters-indicator" />
            )}
          </button>

          {showFilters && (
            <div className="search-form__filters">
              <div className="search-form__filter-group">
                <label>Media Type:</label>
                <select
                  value={filters.mediaType}
                  onChange={(e) => handleFilterChange('mediaType', e.target.value)}
                  disabled={isLoading}
                >
                  <option value="all">All</option>
                  <option value="video">Videos</option>
                  <option value="image">Images</option>
                </select>
              </div>

              <div className="search-form__filter-group">
                <label>Orientation:</label>
                <select
                  value={filters.orientation}
                  onChange={(e) => handleFilterChange('orientation', e.target.value)}
                  disabled={isLoading}
                >
                  <option value="all">All</option>
                  <option value="landscape">Landscape</option>
                  <option value="portrait">Portrait</option>
                </select>
              </div>

              {filters.mediaType === 'video' && (
                <div className="search-form__filter-group">
                  <label>Duration (seconds):</label>
                  <div className="search-form__duration-inputs">
                    <input
                      type="number"
                      placeholder="Min"
                      value={filters.duration?.min || ''}
                      onChange={(e) => handleFilterChange('duration', {
                        ...filters.duration,
                        min: e.target.value ? parseInt(e.target.value) : undefined,
                      })}
                      disabled={isLoading}
                      min="0"
                    />
                    <span>-</span>
                    <input
                      type="number"
                      placeholder="Max"
                      value={filters.duration?.max || ''}
                      onChange={(e) => handleFilterChange('duration', {
                        ...filters.duration,
                        max: e.target.value ? parseInt(e.target.value) : undefined,
                      })}
                      disabled={isLoading}
                      min="0"
                    />
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={clearFilters}
                className="search-form__clear-filters"
                disabled={isLoading}
              >
                Clear Filters
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default SearchForm;