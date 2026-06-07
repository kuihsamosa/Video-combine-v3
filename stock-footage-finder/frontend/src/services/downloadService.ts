import type {
  Download,
  DownloadRequest,
  DownloadListResponse,
  DownloadHistory,
  DownloadStats
} from '../../../shared/types';

const API_BASE_URL = 'http://localhost:8000/api/downloads';

class DownloadService {
  /**
   * Get all downloads with optional status filter
   */
  async getDownloads(
    status?: string, 
    page: number = 1, 
    perPage: number = 20
  ): Promise<DownloadListResponse> {
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        per_page: perPage.toString()
      });
      
      if (status) {
        params.append('status', status);
      }
      
      const response = await fetch(`${API_BASE_URL}?${params}`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch downloads: ${response.statusText}`);
      }
      
      return await response.json();
    } catch (error) {
      console.error('Error fetching downloads:', error);
      throw error;
    }
  }

  /**
   * Get a specific download by ID
   */
  async getDownload(downloadId: string): Promise<Download> {
    try {
      const response = await fetch(`${API_BASE_URL}/${downloadId}`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch download: ${response.statusText}`);
      }
      
      return await response.json();
    } catch (error) {
      console.error('Error fetching download:', error);
      throw error;
    }
  }

  /**
   * Start a new download
   */
  async startDownload(request: DownloadRequest): Promise<Download> {
    try {
      const response = await fetch(API_BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });
      
      if (!response.ok) {
        throw new Error(`Failed to start download: ${response.statusText}`);
      }
      
      const result = await response.json();
      return result.download;
    } catch (error) {
      console.error('Error starting download:', error);
      throw error;
    }
  }

  /**
   * Pause a download
   */
  async pauseDownload(downloadId: string): Promise<Download> {
    try {
      const response = await fetch(`${API_BASE_URL}/${downloadId}/pause`, {
        method: 'POST',
      });
      
      if (!response.ok) {
        throw new Error(`Failed to pause download: ${response.statusText}`);
      }
      
      const result = await response.json();
      return result.download;
    } catch (error) {
      console.error('Error pausing download:', error);
      throw error;
    }
  }

  /**
   * Resume a download
   */
  async resumeDownload(downloadId: string): Promise<Download> {
    try {
      const response = await fetch(`${API_BASE_URL}/${downloadId}/resume`, {
        method: 'POST',
      });
      
      if (!response.ok) {
        throw new Error(`Failed to resume download: ${response.statusText}`);
      }
      
      const result = await response.json();
      return result.download;
    } catch (error) {
      console.error('Error resuming download:', error);
      throw error;
    }
  }

  /**
   * Cancel/delete a download
   */
  async cancelDownload(downloadId: string): Promise<void> {
    try {
      const response = await fetch(`${API_BASE_URL}/${downloadId}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        throw new Error(`Failed to cancel download: ${response.statusText}`);
      }
    } catch (error) {
      console.error('Error cancelling download:', error);
      throw error;
    }
  }

  /**
   * Retry a failed download
   */
  async retryDownload(downloadId: string): Promise<Download> {
    try {
      const response = await fetch(`${API_BASE_URL}/${downloadId}/retry`, {
        method: 'POST',
      });
      
      if (!response.ok) {
        throw new Error(`Failed to retry download: ${response.statusText}`);
      }
      
      const result = await response.json();
      return result.download;
    } catch (error) {
      console.error('Error retrying download:', error);
      throw error;
    }
  }

  /**
   * Get download history
   */
  async getDownloadHistory(downloadId: string): Promise<DownloadHistory[]> {
    try {
      const response = await fetch(`${API_BASE_URL}/${downloadId}/history`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch download history: ${response.statusText}`);
      }
      
      return await response.json();
    } catch (error) {
      console.error('Error fetching download history:', error);
      throw error;
    }
  }

  /**
   * Get download statistics
   */
  async getDownloadStats(): Promise<DownloadStats> {
    try {
      const response = await fetch(`${API_BASE_URL}/stats`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch download statistics: ${response.statusText}`);
      }
      
      return await response.json();
    } catch (error) {
      console.error('Error fetching download statistics:', error);
      throw error;
    }
  }

  /**
   * Format file size from bytes to human readable format
   */
  formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Format download speed from bytes/sec to human readable format
   */
  formatDownloadSpeed(bytesPerSecond: number): string {
    return this.formatFileSize(bytesPerSecond) + '/s';
  }

  /**
   * Format ETA from seconds to human readable format
   */
  formatETA(seconds: number): string {
    if (seconds === 0 || !seconds) return 'Unknown';
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${remainingSeconds}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    } else {
      return `${remainingSeconds}s`;
    }
  }

  /**
   * Get status color for download status
   */
  getStatusColor(status: string): string {
    switch (status) {
      case 'completed':
        return '#4caf50'; // green
      case 'downloading':
        return '#2196f3'; // blue
      case 'paused':
        return '#ff9800'; // orange
      case 'failed':
        return '#f44336'; // red
      case 'cancelled':
        return '#9e9e9e'; // grey
      case 'pending':
        return '#9c27b0'; // purple
      default:
        return '#757575'; // default grey
    }
  }

  /**
   * Get status icon for download status
   */
  getStatusIcon(status: string): string {
    switch (status) {
      case 'completed':
        return '✓';
      case 'downloading':
        return '↓';
      case 'paused':
        return '⏸';
      case 'failed':
        return '✗';
      case 'cancelled':
        return '✕';
      case 'pending':
        return '⏳';
      default:
        return '?';
    }
  }

  /**
   * Poll for download updates
   */
  async pollDownloadUpdates(
    downloadId: string, 
    callback: (download: Download) => void, 
    interval: number = 1000
  ): Promise<() => void> {
    let isActive = true;
    
    const poll = async () => {
      if (!isActive) return;
      
      try {
        const download = await this.getDownload(downloadId);
        callback(download);
        
        // Stop polling if download is in a terminal state
        if (['completed', 'failed', 'cancelled'].includes(download.status)) {
          isActive = false;
          return;
        }
        
        // Schedule next poll
        setTimeout(poll, interval);
      } catch (error) {
        console.error('Error polling download updates:', error);
        // Continue polling even if there's an error
        setTimeout(poll, interval);
      }
    };
    
    // Start polling
    poll();
    
    // Return function to stop polling
    return () => {
      isActive = false;
    };
  }

  /**
   * Poll for multiple download updates
   */
  async pollMultipleDownloads(
    callback: (downloads: Download[]) => void, 
    interval: number = 2000
  ): Promise<() => void> {
    let isActive = true;
    
    const poll = async () => {
      if (!isActive) return;
      
      try {
        const response = await this.getDownloads();
        callback(response.downloads);
        
        // Schedule next poll
        setTimeout(poll, interval);
      } catch (error) {
        console.error('Error polling multiple downloads:', error);
        // Continue polling even if there's an error
        setTimeout(poll, interval);
      }
    };
    
    // Start polling
    poll();
    
    // Return function to stop polling
    return () => {
      isActive = false;
    };
  }
}

// Export singleton instance
export const downloadService = new DownloadService();
export default downloadService;