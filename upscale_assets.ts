import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

// --- CONFIGURATION ---
// node run npx tsx upscale_assets.ts [input_dir] [--concurrent 4] [--keep-original]
const args = process.argv.slice(2);
let TargetDirArg = '';
let concurrency = 4; // Default concurrency
let keepOriginal = false;

for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--concurrent' || arg === '-c') {
        concurrency = parseInt(args[++i], 10);
        if (isNaN(concurrency)) concurrency = 4;
    } else if (arg === '--keep-original' || arg === '-k') {
        keepOriginal = true;
    } else if (!arg.startsWith('-')) {
        TargetDirArg = arg;
    }
}

if (!TargetDirArg) {
    console.error("Please provide a directory path. Example: npx tsx upscale_assets.ts \"D:/pictures/my-asset-pack\" --concurrent 4 --keep-original");
    process.exit(1);
}

const TARGET_DIR = path.resolve(TargetDirArg);

// Path to the CLI executable
const UPSCALER_BIN = path.resolve('./bin/realEsgran/realesrgan-ncnn-vulkan-20220424-windows/realesrgan-ncnn-vulkan.exe');
const MODEL_NAME = 'realesrgan-x4plus';
const execFileAsync = promisify(execFile);

// Helper to recursively find all images
async function walkDir(dir: string, fileList: string[] = []): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            await walkDir(fullPath, fileList);
        } else {
            if (/\.(jpg|jpeg|png|webp)$/i.test(entry.name) && !entry.name.includes('_upscaled')) {
                fileList.push(fullPath);
            }
        }
    }
    return fileList;
}

// Convert extension to realesrgan format argument
function getFormat(ext: string) {
    ext = ext.toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'jpg';
    if (ext === '.webp') return 'webp';
    return 'png'; // default fallback wrapper
}

// Helper to run promises with a concurrency limit
async function processInParallel<T>(items: T[], concurrency: number, processor: (item: T) => Promise<void>) {
    let index = 0;
    const workers = Array(concurrency).fill(null).map(async () => {
        while (index < items.length) {
            const currentItem = items[index++];
            await processor(currentItem);
        }
    });
    await Promise.all(workers);
}

const processImages = async () => {
    const rl = readline.createInterface({ input, output });

    try {
        if (!existsSync(UPSCALER_BIN)) {
            throw new Error(`Upscaler binary not found at: ${UPSCALER_BIN}\nPlease check the path or download the release.`);
        }

        if (!existsSync(TARGET_DIR)) {
            console.error(`Target directory not found: ${TARGET_DIR}`);
            process.exit(1);
        }

        console.log(`Scanning ${TARGET_DIR} recursively...`);
        const allImageFiles = await walkDir(TARGET_DIR);

        // Filter out files that already have an _upscaled counterpart
        const imageFiles: string[] = [];
        let skipCount = 0;

        for (const file of allImageFiles) {
            const parsed = path.parse(file);
            const upscaledPath = path.join(parsed.dir, `${parsed.name}_upscaled${parsed.ext}`);
            if (existsSync(upscaledPath)) {
                skipCount++;
            } else {
                imageFiles.push(file);
            }
        }

        if (skipCount > 0) {
            console.log(`⏭️ Skipped ${skipCount} images that already have _upscaled versions (resuming).`);
        }

        if (imageFiles.length === 0) {
            console.log(`No images left to process in ${TARGET_DIR}`);
            return;
        }

        console.log(`🚀 Found ${imageFiles.length} images to process. Starting batch upscale with concurrency: ${concurrency}`);

        let successCount = 0;
        let failCount = 0;

        await processInParallel(imageFiles, concurrency, async (filePath) => {
            const startTime = Date.now();
            const parsedPath = path.parse(filePath);
            const ext = parsedPath.ext;

            // Realesrgan will complain if the output path has an extension opposite to the format.
            // But we will use a temp generic name and let the tool assign exactly what we ask.
            const outFormat = getFormat(ext);
            const tempFileName = `_upscaling_temp_${Math.random().toString(36).substr(2, 9)}.${outFormat}`;
            const tempPath = path.join(parsedPath.dir, tempFileName);

            const relativePath = path.relative(TARGET_DIR, filePath);
            console.log(`[START] ${relativePath}`);

            try {
                await execFileAsync(UPSCALER_BIN, [
                    '-i', filePath,
                    '-o', tempPath,
                    '-n', MODEL_NAME,
                    '-s', '4', // Scale factor (4x)
                    '-f', outFormat
                ]);

                // Verify temp file exists and has size
                const stats = await fs.stat(tempPath);
                if (stats.size > 0) {
                    if (keepOriginal) {
                        const newFileName = `${parsedPath.name}_upscaled${ext}`;
                        const newFilePath = path.join(parsedPath.dir, newFileName);
                        await fs.rename(tempPath, newFilePath);
                    } else {
                        // Replace the original immediately
                        await fs.rename(tempPath, filePath);
                    }

                    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                    console.log(`[SUCCESS] ${relativePath} in ${duration}s`);
                    successCount++;
                } else {
                    console.log(`[FAIL] ${relativePath} (Empty file output)`);
                    failCount++;
                }
            } catch (err: any) {
                console.error(`[ERROR] ${relativePath} failed:`, err.message || err);
                failCount++;
                try {
                    // Clean up temp file on failure
                    if (existsSync(tempPath)) {
                        await fs.unlink(tempPath);
                    }
                } catch (e) {
                    // ignore
                }
            }
        });

        console.log('\n================================================');
        console.log(`🎉 Batch Processing Complete!`);
        console.log(`✅ Success: ${successCount} | ❌ Failed: ${failCount}`);
        if (keepOriginal) {
            console.log('Original files successfully kept, upscaled files created with _upscaled suffix.');
        } else {
            console.log('Original files successfully overwritten with upscaled versions.');
        }

    } catch (error) {
        console.error('Fatal Error:', error);
    } finally {
        rl.close();
    }
};

processImages();
