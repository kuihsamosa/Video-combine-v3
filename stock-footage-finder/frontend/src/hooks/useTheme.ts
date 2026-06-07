import { useEffect } from 'react';
import { useLocalStorage } from './useLocalStorage';
import type { Theme } from '../types';

const lightTheme: Theme = {
  mode: 'light',
  colors: {
    background: '#ffffff',
    surface: '#f8f9fa',
    primary: '#007bff',
    secondary: '#6c757d',
    text: '#212529',
    textSecondary: '#6c757d',
    border: '#dee2e6',
    error: '#dc3545',
    success: '#28a745',
    warning: '#ffc107',
  },
};

const darkTheme: Theme = {
  mode: 'dark',
  colors: {
    background: '#121212',
    surface: '#1e1e1e',
    primary: '#0d6efd',
    secondary: '#6c757d',
    text: '#ffffff',
    textSecondary: '#adb5bd',
    border: '#495057',
    error: '#dc3545',
    success: '#198754',
    warning: '#ffc107',
  },
};

export function useTheme() {
  const [theme, setTheme] = useLocalStorage<Theme>('theme', lightTheme);

  const toggleTheme = () => {
    const newTheme = theme.mode === 'light' ? darkTheme : lightTheme;
    setTheme(newTheme);
  };

  const setLightTheme = () => {
    setTheme(lightTheme);
  };

  const setDarkTheme = () => {
    setTheme(darkTheme);
  };

  useEffect(() => {
    const root = document.documentElement;
    
    // Apply CSS custom properties for theme colors
    Object.entries(theme.colors).forEach(([key, value]) => {
      root.style.setProperty(`--color-${key}`, value);
    });

    // Set data attribute for CSS targeting
    root.setAttribute('data-theme', theme.mode);
  }, [theme]);

  useEffect(() => {
    // Check for system preference on initial load
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    
    const handleChange = (e: MediaQueryListEvent) => {
      if (!localStorage.getItem('theme')) {
        setTheme(e.matches ? darkTheme : lightTheme);
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    
    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, [setTheme]);

  return {
    theme,
    toggleTheme,
    setLightTheme,
    setDarkTheme,
    isLight: theme.mode === 'light',
    isDark: theme.mode === 'dark',
  };
}