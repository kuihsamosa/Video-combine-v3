import React, { useState, useEffect } from 'react';
import { Search, History, Star, Settings, Info, Moon, Sun, AlertTriangle } from 'lucide-react';
import { useMediaSearch } from '../hooks/useMediaSearch';
import { useThemeContext } from '../contexts/ThemeContext';
import { storageService } from '../services/storageService';
import SearchForm from '../components/SearchForm';
import MediaGrid from '../components/MediaGrid';
import VideoPreview from '../components/VideoPreview';
import type { MediaItem, SearchParams, SearchHistoryItem } from '../types';

export default function HomePage() {
  const {
    results,
    isLoading,
    error,
    hasSearched,
    totalCount,
    search,
    loadMore,
    hasMore,
    getSearchHistory,
  } = useMediaSearch();

  const { theme, toggleTheme, isDark } = useThemeContext();
  const [showPreview, setShowPreview] = useState(false);
  const [previewMedia, setPreviewMedia] = useState<MediaItem | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([]);

  // Flatten all media items from all search results
  const allMediaItems = results.flatMap(result => result.results);

  useEffect(() => {
    setSearchHistory(getSearchHistory());
  }, [getSearchHistory]);

  const handleSearch = async (params: SearchParams) => {
    await search(params);
    setShowHistory(false);
  };

  const handlePreview = (mediaItem: MediaItem) => {
    setPreviewMedia(mediaItem);
    setPreviewIndex(allMediaItems.findIndex(item => item.id === mediaItem.id));
    setShowPreview(true);
  };

  const handleClosePreview = () => {
    setShowPreview(false);
    setPreviewMedia(null);
    setPreviewIndex(0);
  };

  const handleNextPreview = () => {
    const nextIndex = (previewIndex + 1) % allMediaItems.length;
    setPreviewIndex(nextIndex);
    setPreviewMedia(allMediaItems[nextIndex]);
  };

  const handlePreviousPreview = () => {
    const prevIndex = previewIndex === 0 ? allMediaItems.length - 1 : previewIndex - 1;
    setPreviewIndex(prevIndex);
    setPreviewMedia(allMediaItems[prevIndex]);
  };

  const handleHistoryItemClick = (item: SearchHistoryItem) => {
    const searchParams: SearchParams = {
      query: item.query,
      sources: [], // Will use default sources
      perPage: 20,
      page: 1,
      mediaType: 'all',
      orientation: 'all',
    };
    handleSearch(searchParams);
  };

  const handleClearHistory = () => {
    storageService.clearSearchHistory();
    setSearchHistory([]);
  };

  const handleHistoryToggle = () => {
    setShowHistory(!showHistory);
  };

  const renderSearchHistory = () => {
    if (!showHistory) return null;

    return (
      <div className="home-page__history">
        <div className="home-page__history-header">
          <h3 className="home-page__history-title">
            <History size={16} />
            Recent Searches
          </h3>
          <button
            onClick={handleClearHistory}
            className="home-page__history-clear"
          >
            Clear
          </button>
        </div>
        
        {searchHistory.length === 0 ? (
          <p className="home-page__history-empty">
            No search history yet
          </p>
        ) : (
          <div className="home-page__history-list">
            {searchHistory.slice(0, 10).map((item, index) => (
              <button
                key={index}
                onClick={() => handleHistoryItemClick(item)}
                className="home-page__history-item"
              >
                <span className="home-page__history-query">
                  {item.query}
                </span>
                <span className="home-page__history-count">
                  {item.resultCount} results
                </span>
                <span className="home-page__history-time">
                  {new Date(item.timestamp).toLocaleDateString()}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderError = () => {
    if (!error) return null;

    return (
      <div className="home-page__error" role="alert">
        <div className="home-page__error-icon" aria-hidden="true">
          <AlertTriangle size={28} />
        </div>
        <div className="home-page__error-content">
          <h3>Search Error</h3>
          <p>{error}</p>
        </div>
        <div className="home-page__error-actions">
          <button
            onClick={() => {/* Retry last search */}}
            className="home-page__error-retry"
          >
            Retry
          </button>
        </div>
      </div>
    );
  };

  const renderEmptyState = () => {
    if (hasSearched || showHistory) return null;

    return (
      <div className="home-page__empty">
        <div className="home-page__empty-content">
          <Search size={48} className="home-page__empty-icon" />
          <h2>Find the Perfect Stock Media</h2>
          <p>
            Search across multiple stock footage and image sources to find the perfect media for your project.
          </p>
          
          <div className="home-page__empty-features">
            <div className="home-page__feature">
              <Search size={32} className="home-page__feature-icon" />
              <h3>Powerful Search</h3>
              <p>Search across multiple sources with advanced filters</p>
            </div>
            
            <div className="home-page__feature">
              <Star size={32} className="home-page__feature-icon" />
              <h3>Save Favorites</h3>
              <p>Keep track of your favorite media items</p>
            </div>
            
            <div className="home-page__feature">
              <Settings size={32} className="home-page__feature-icon" />
              <h3>API Key Management</h3>
              <p>Securely manage API keys for all sources</p>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="home-page">
      {/* Header */}
      <header className="home-page__header">
        <div className="home-page__header-content">
          <div className="home-page__logo">
            <h1>Stock Footage Finder</h1>
          </div>
          
          <nav className="home-page__nav">
            <button
              onClick={handleHistoryToggle}
              className={`home-page__nav-button ${showHistory ? 'home-page__nav-button--active' : ''}`}
              aria-label="Toggle search history"
            >
              <History size={24} />
            </button>
            
            <a
              href="/settings"
              className="home-page__nav-button"
              aria-label="Settings"
            >
              <Settings size={20} />
            </a>
            
            <a
              href="/about"
              className="home-page__nav-button"
              aria-label="About"
            >
              <Info size={20} />
            </a>
            
            <button
              onClick={toggleTheme}
              className="home-page__nav-button"
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {isDark ? <Sun size={24} /> : <Moon size={24} />}
            </button>
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <main className="home-page__main">
        {/* Search Section */}
        <section className="home-page__search-section">
          <SearchForm
            onSearch={handleSearch}
            isLoading={isLoading}
          />
          
          {/* Search History */}
          {renderSearchHistory()}
        </section>

        {/* Error Display */}
        {renderError()}

        {/* Empty State */}
        {renderEmptyState()}

        {/* Results Grid */}
        {hasSearched && (
          <section className="home-page__results-section">
            <MediaGrid
              results={results}
              isLoading={isLoading}
              onLoadMore={loadMore}
              hasMore={hasMore}
              onPreview={handlePreview}
            />
          </section>
        )}
      </main>

      {/* Video Preview Modal */}
      {showPreview && previewMedia && (
        <VideoPreview
          mediaItem={previewMedia}
          isOpen={showPreview}
          onClose={handleClosePreview}
          onNext={allMediaItems.length > 1 ? handleNextPreview : undefined}
          onPrevious={allMediaItems.length > 1 ? handlePreviousPreview : undefined}
        />
      )}

      {/* Footer */}
      <footer className="home-page__footer">
        <p>
          © 2024 Stock Footage Finder. Search across multiple stock media sources.
        </p>
      </footer>
    </div>
  );
}