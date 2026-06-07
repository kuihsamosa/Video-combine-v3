import { useState, useCallback, useEffect } from 'react';
import { apiService } from '../services/apiService';
import { storageService } from '../services/storageService';
import { useApiKeyContext } from '../contexts/ApiKeyContext';
import type { 
  SearchResult, 
  SearchParams, 
  SearchHistoryItem, 
  ApiError 
} from '../types';

interface UseMediaSearchState {
  results: SearchResult[];
  isLoading: boolean;
  error: string | null;
  hasSearched: boolean;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  hasMore: boolean;
}

interface UseMediaSearchActions {
  search: (params: SearchParams) => Promise<void>;
  loadMore: () => Promise<void>;
  clearResults: () => void;
  retrySearch: () => Promise<void>;
  getSearchHistory: () => SearchHistoryItem[];
  clearSearchHistory: () => void;
}

export function useMediaSearch(): UseMediaSearchState & UseMediaSearchActions {
  const [state, setState] = useState<UseMediaSearchState>({
    results: [],
    isLoading: false,
    error: null,
    hasSearched: false,
    totalCount: 0,
    currentPage: 1,
    totalPages: 0,
    hasMore: true,
  });

  const [lastSearchParams, setLastSearchParams] = useState<SearchParams | null>(null);
  const { apiKeys, hasApiKey } = useApiKeyContext();

  // Calculate total results and pages
  useEffect(() => {
    const totalCount = state.results.reduce((sum, result) => sum + (result.totalCount || 0), 0);
    const maxPerPage = Math.max(...state.results.map(r => r.perPage || 20));
    const totalPages = maxPerPage > 0 ? Math.ceil(totalCount / maxPerPage) : 0;
    const hasMore = state.currentPage < totalPages;
    
    setState(prev => ({
      ...prev,
      totalCount,
      totalPages,
      hasMore,
    }));
  }, [state.results, state.currentPage]);

  const search = useCallback(async (params: SearchParams) => {
    setState(prev => ({
      ...prev,
      isLoading: true,
      error: null,
    }));

    try {
      // Filter sources that have API keys
      const availableSources = params.sources.filter(source => 
        !hasApiKey(source) || apiKeys[source as keyof typeof apiKeys]
      );

      if (availableSources.length === 0) {
        throw new Error('No API keys available for selected sources');
      }

      const searchParams = {
        ...params,
        sources: availableSources,
        page: 1,
      };

      const results = await apiService.searchMedia(searchParams);
      
      // Add to search history
      const historyItem: SearchHistoryItem = {
        query: params.query,
        timestamp: new Date(),
        resultCount: results.reduce((sum, result) => sum + (result.totalCount || 0), 0),
      };
      storageService.addSearchHistoryItem(historyItem);

      setState({
        results,
        isLoading: false,
        error: null,
        hasSearched: true,
        totalCount: results.reduce((sum, result) => sum + (result.totalCount || 0), 0),
        currentPage: 1,
        totalPages: 0, // Will be calculated by useEffect
        hasMore: true, // Will be calculated by useEffect
      });

      setLastSearchParams(searchParams);
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Search failed',
      }));
    }
  }, [apiKeys, hasApiKey]);

  const loadMore = useCallback(async () => {
    if (!lastSearchParams || state.isLoading || state.currentPage >= state.totalPages) {
      return;
    }

    setState(prev => ({
      ...prev,
      isLoading: true,
      error: null,
    }));

    try {
      const nextPageParams = {
        ...lastSearchParams,
        page: state.currentPage + 1,
      };

      const newResults = await apiService.searchMedia(nextPageParams);
      
      setState(prev => ({
        ...prev,
        results: [...prev.results, ...newResults],
        isLoading: false,
        error: null,
        currentPage: prev.currentPage + 1,
      }));
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load more results',
      }));
    }
  }, [lastSearchParams, state.isLoading, state.currentPage, state.totalPages]);

  const clearResults = useCallback(() => {
    setState({
      results: [],
      isLoading: false,
      error: null,
      hasSearched: false,
      totalCount: 0,
      currentPage: 1,
      totalPages: 0,
      hasMore: true,
    });
    setLastSearchParams(null);
  }, []);

  const retrySearch = useCallback(async () => {
    if (lastSearchParams) {
      await search(lastSearchParams);
    }
  }, [lastSearchParams, search]);

  const getSearchHistory = useCallback((): SearchHistoryItem[] => {
    return storageService.getSearchHistory();
  }, []);

  const clearSearchHistory = useCallback(() => {
    storageService.clearSearchHistory();
  }, []);

  return {
    ...state,
    search,
    loadMore,
    clearResults,
    retrySearch,
    getSearchHistory,
    clearSearchHistory,
  };
}