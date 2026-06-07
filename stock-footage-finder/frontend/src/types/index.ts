// Re-export shared types from the shared directory
export * from '../../../shared/types';

// Import MediaItem for use in frontend-specific types
import type { MediaItem } from '../../../shared/types';

// Additional frontend-specific types
export interface Theme {
  mode: 'light' | 'dark';
  colors: {
    background: string;
    surface: string;
    primary: string;
    secondary: string;
    text: string;
    textSecondary: string;
    border: string;
    error: string;
    success: string;
    warning: string;
  };
}

export interface ApiResponse<T> {
  data: T;
  success: boolean;
  message?: string;
  error?: string;
}

export interface ApiError {
  message: string;
  status?: number;
  code?: string;
}

export interface NavigationItem {
  path: string;
  label: string;
  icon?: string;
}

export interface ModalState {
  isOpen: boolean;
  content?: React.ReactNode;
  title?: string;
}

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;
  duration?: number;
}

export interface DownloadProgress {
  id: string;
  url: string;
  filename: string;
  progress: number;
  status: 'pending' | 'downloading' | 'completed' | 'error';
  error?: string;
}

export interface FilterOptions {
  mediaType: 'video' | 'image' | 'all';
  orientation: 'landscape' | 'portrait' | 'all';
  duration?: {
    min?: number;
    max?: number;
  };
  size?: {
    min?: number;
    max?: number;
  };
}

export interface SearchHistoryItem {
  query: string;
  timestamp: Date;
  resultCount: number;
}

export interface FavoriteItem {
  mediaItem: MediaItem;
  addedAt: Date;
  tags?: string[];
}