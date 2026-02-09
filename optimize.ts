
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import sharp from 'sharp';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

// --- CONFIGURATION ---
// Allow override via command line args: node optimize.js [input_dir]
const TargetDirArg = process.argv[2];

if (!TargetDirArg) {
    console.error("Please provide a directory path. Example: npx tsx optimize.ts \"D:/pictures/my-folder\"");
    process.exit(1);
}

const TARGET_DIR = path.resolve(TargetDirArg);
const TEMP_DIR = path.join(TARGET_DIR, 'temp_upscale_work'); // Intermediate folder for upscaled work

// Path to the CLI executable we downloaded
// Adjusted for your specific directory structure:
const UPSCALER_BIN = path.resolve('./bin/realEsgran/realesrgan-ncnn-vulkan-20220424-windows/realesrgan-ncnn-vulkan.exe');

// The model to use (matches Upscayl's default "Real-ESRGAN" mode)
const MODEL_NAME = 'realesrgan-x4plus';

const execFileAsync = promisify(execFile);

const processImages = async () => {
    const rl = readline.createInterface({ input, output });

    try {
        // 0. Pre-flight check for binary and models
        if (!existsSync(UPSCALER_BIN)) {
            throw new Error(`Upscaler binary not found at: ${UPSCALER_BIN}\nPlease check the path or download the release.`);
        }

        // Check for models directory adjacent to binary
        const modelsDir = path.join(path.dirname(UPSCALER_BIN), 'models');
        // Note: Some versions might embed models or look elsewhere, but typically they are in 'models'.
        // We won't block execution if models dir is missing (maybe user has them elsewhere or embedded),
        // but we will warn if execution fails later.

        // 1. Ensure directories exist
        if (!existsSync(TARGET_DIR)) {
            console.error(`Target directory not found: ${TARGET_DIR}`);
            process.exit(1);
        }
        await fs.mkdir(TEMP_DIR, { recursive: true });

        // 2. Read files
        const files = await fs.readdir(TARGET_DIR);
        const imageFiles = files.filter(file => /\.(jpg|jpeg|png|webp)$/i.test(file));

        if (imageFiles.length === 0) {
            console.log(`No images found in ${TARGET_DIR}`);
            return;
        }

        console.log(`🚀 Found ${imageFiles.length} images in ${TARGET_DIR}. Starting workflow...`);
        console.log(`Output will save to same folder: ${TARGET_DIR}`);

        const filesToCleanup: string[] = [];

        // 3. Process Sequence
        for (const file of imageFiles) {
            // Skip our own output if we re-run
            if (file.endsWith('_processed.webp')) continue;
            // Skip if the file is already a .webp and not an original that needs processing
            // Heuristic: if it's a webp, we only process it if user explicitly wants to force upscale?
            // User requirement: "If say there si already a webP file, process it anyway and replace the image if possible"
            // So we do NOT skip webp files. We just need to handle overwrite carefully.

            const startTime = Date.now();
            const inputPath = path.join(TARGET_DIR, file);
            const parsedPath = path.parse(file);
            const tempFileName = `${parsedPath.name}_upscaled.png`;
            const tempPath = path.join(TEMP_DIR, tempFileName);

            let finalFileName = `${parsedPath.name}.webp`;
            let outputPath = path.join(TARGET_DIR, finalFileName);

            console.log(`\nProcessing: ${file}`);

            // STEP A: UPSCALE (Real-ESRGAN)
            // We output to PNG first to preserve maximum quality before WebP compression
            process.stdout.write('  1. Upscaling... ');

            try {
                await execFileAsync(UPSCALER_BIN, [
                    '-i', inputPath,
                    '-o', tempPath,
                    '-n', MODEL_NAME,
                    '-s', '4', // Scale factor (4x)
                    '-f', 'png'
                ]);
                process.stdout.write('✅\n');
            } catch (err: any) {
                process.stdout.write('❌\n');
                console.error('Upscaling failed.');
                console.error(`Command: ${UPSCALER_BIN} -i ...`);
                console.error('Error details:', err.message || err);

                if (!existsSync(modelsDir)) {
                    console.error('\n⚠️  POSSIBLE CAUSE: The "models" directory is missing!');
                    console.error(`Expected at: ${modelsDir}`);
                    console.error('Please ensure you extracted the "models" folder from the Real-ESRGAN release alongside the executable.');
                }
                // STEP C: CLEANUP TEMP (if upscaling failed, tempPath might still exist)
                try {
                    await fs.unlink(tempPath);
                } catch (e) {
                    // ignore cleanup errors
                }
                continue;
            }

            // STEP B: COMPRESS (Sharp -> WebP)
            process.stdout.write('  2. Compressing to WebP... ');

            let compressionSuccess = false;
            try {
                // Try to overwrite first
                await sharp(tempPath)
                    .webp({
                        quality: 75, // Adjust 0-100. 75 is usually indistinguishable from original
                        smartSubsample: true, // High quality chroma subsampling
                        effort: 4, // CPU effort (0-6). 4 is a good balance of speed/size
                    })
                    .toFile(outputPath);
                compressionSuccess = true;

            } catch (err: any) {
                // Fallback logic: if overwrite failed (e.g. locked), try suffix
                console.warn(`\nCould not write to ${finalFileName} (maybe locked?), trying _processed suffix...`);
                finalFileName = `${parsedPath.name}_processed.webp`;
                outputPath = path.join(TARGET_DIR, finalFileName);
                try {
                    await sharp(tempPath)
                        .webp({
                            quality: 75,
                            smartSubsample: true,
                            effort: 4,
                        })
                        .toFile(outputPath);
                    compressionSuccess = true;
                } catch (finalErr: any) {
                    process.stdout.write('❌\n');
                    console.error('Compression failed completely:', finalErr.message);
                }
            }

            if (compressionSuccess) {
                // Verify file exists and has size
                try {
                    const stats = await fs.stat(outputPath);
                    if (stats.size > 0) {
                        process.stdout.write('✅\n');
                        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                        console.log(`✨ Done in ${duration}s -> ${finalFileName} (${(stats.size / 1024).toFixed(2)} KB)`);

                        // Mark strictly original file for cleanup ONLY if it's different from output
                        // Example: input=foo.jpg, output=foo.webp -> cleanup foo.jpg
                        // Example: input=foo.webp, output=foo.webp -> NO cleanup
                        if (inputPath !== outputPath) {
                            filesToCleanup.push(inputPath);
                        }
                    } else {
                        process.stdout.write('❌ (Empty file generated)\n');
                    }
                } catch (statErr: any) {
                    process.stdout.write('❌\n');
                    console.error('Output file verification failed:', statErr.message);
                }
            }

            // STEP C: CLEANUP TEMP
            try {
                await fs.unlink(tempPath);
            } catch (e) {
                // ignore temp cleanup errors
            }
        }

        // Cleanup temp folder
        try {
            await fs.rm(TEMP_DIR, { recursive: true, force: true });
        } catch (e) { }


        // 4. Interactive Cleanup
        if (filesToCleanup.length > 0) {
            console.log('\n------------------------------------------------');
            console.log(`✅ Successfully optimized ${filesToCleanup.length} files.`);
            console.log('Original files can be deleted to save space.');

            const answer = await rl.question('Do you want to delete the ORIGINAL unoptimized files? (y/N): ');

            if (answer.trim().toLowerCase() === 'y') {
                console.log('Deleting originals...');
                for (const originalPath of filesToCleanup) {
                    try {
                        await fs.unlink(originalPath);
                        console.log(`Deleted: ${path.basename(originalPath)}`);
                    } catch (err: any) {
                        console.error(`Failed to delete ${path.basename(originalPath)}:`, err.message);
                    }
                }
                console.log('Cleanup complete.');
            } else {
                console.log('Originals kept.');
            }
        } else {
            console.log('\nNo original files to cleanup (or files were updated in-place).');
        }

        console.log('\n🎉 All operations completed.');

    } catch (error) {
        console.error('Fatal Error:', error);
    } finally {
        rl.close();
    }
};

processImages();
