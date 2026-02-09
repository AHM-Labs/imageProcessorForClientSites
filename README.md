# Image Optimizer

This tool automatically upscales images using Real-ESRGAN and compresses them to high-quality WebP using Sharp.

## setup

1.  **Install Dependencies:**
    ```bash
    npm install
    ```

2.  **Verify Upscaler:**
    Ensure you have `realesrgan-ncnn-vulkan.exe` and the `models` folder in:
    `d:/code/imageProcessorForClientSites/bin/realEsgran/realesrgan-ncnn-vulkan-20220424-windows/`

## Usage

This script processes images IN PLACE. It takes a folder path, optimizations all matching images, saves them as `.webp` in the SAME folder, and optionally offers to delete the originals.

**Run with a target directory:**
```bash
npx tsx optimize.ts "D:/pictures/ahm-design/mistaTwister"
```

**Features:**
*   **Upscaling:** 4x upscale using Real-ESRGAN.
*   **Compression:** High-quality WebP compression.
*   **Overwrite:** If a `.webp` file already exists, it will try to overwrite it.
*   **Cleanup:** At the end, you can choose to delete the original source files (e.g., .jpg, .png) to save space.

**Note:**
Always use quotes around paths with spaces.
