'use client';

/**
 * ImageUpload Component
 * =====================
 * Provides drag-and-drop and click-to-upload functionality.
 * 
 * Use Cases:
 * - Fallback when webcam is unavailable
 * - Upload pre-taken photos
 * - Portrait mode on mobile devices
 * 
 * Supported Formats:
 * - JPEG, PNG, WEBP
 * - Max size configurable (default 10MB)
 */

import { useRef, useState, useCallback } from 'react';
import styles from './ImageUpload.module.css';

interface ImageUploadProps {
  onUpload: (imageData: string) => void;
  onError?: (error: string) => void;
  maxSizeMB?: number;
  minWidth?: number;
  minHeight?: number;
  acceptedFormats?: string[];
}

export default function ImageUpload({
  onUpload,
  onError,
  maxSizeMB = 10,
  minWidth = 200,
  minHeight = 200,
  acceptedFormats = ['image/jpeg', 'image/png', 'image/webp'],
}: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  const validateFile = useCallback((file: File): boolean => {
    // Check file type
    if (!acceptedFormats.includes(file.type)) {
      const formats = acceptedFormats.map(f => f.replace('image/', '').toUpperCase()).join(', ');
      onError?.(`Invalid file type. Please use: ${formats}`);
      return false;
    }

    // Check file size
    const maxBytes = maxSizeMB * 1024 * 1024;
    if (file.size > maxBytes) {
      onError?.(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max size: ${maxSizeMB}MB`);
      return false;
    }

    return true;
  }, [acceptedFormats, maxSizeMB, onError]);

  const validateImageDimensions = useCallback((img: HTMLImageElement): boolean => {
    if (img.width < minWidth || img.height < minHeight) {
      onError?.(`Image too small (${img.width}×${img.height}). Minimum size: ${minWidth}×${minHeight} pixels`);
      return false;
    }
    return true;
  }, [minWidth, minHeight, onError]);

  const processFile = useCallback((file: File) => {
    if (!validateFile(file)) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      
      // Validate image dimensions
      const img = new Image();
      img.onload = () => {
        if (validateImageDimensions(img)) {
          setPreview(result);
          onUpload(result);
        }
      };
      img.onerror = () => {
        onError?.('Failed to load image. Please try another file.');
      };
      img.src = result;
    };
    reader.onerror = () => {
      onError?.('Failed to read file. Please try again.');
    };
    reader.readAsDataURL(file);
  }, [validateFile, validateImageDimensions, onUpload, onError]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files[0];
    if (file) {
      processFile(file);
    }
  }, [processFile]);

  const handleClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processFile(file);
    }
  }, [processFile]);

  const clearPreview = useCallback(() => {
    setPreview(null);
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }, []);

  return (
    <div className={styles.uploadContainer}>
      {preview ? (
        <div className={styles.previewContainer}>
          <img src={preview} alt="Upload preview" className={styles.preview} />
          <button onClick={clearPreview} className={styles.clearButton}>
            ✕ Clear
          </button>
        </div>
      ) : (
        <div
          className={`${styles.dropzone} ${isDragging ? styles.dragging : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={handleClick}
        >
          <span className={styles.uploadIcon}>📁</span>
          <p className={styles.mainText}>
            Drag & drop your photo here
          </p>
          <p className={styles.subText}>
            or click to browse
          </p>
          <p className={styles.formatHint}>
            JPEG, PNG, WEBP • Min {minWidth}×{minHeight}px • Max {maxSizeMB}MB
          </p>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={acceptedFormats.join(',')}
        onChange={handleChange}
        className={styles.hiddenInput}
      />
    </div>
  );
}
