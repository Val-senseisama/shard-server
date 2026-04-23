import { spawn } from 'child_process';
import { writeFile } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function startTunnel() {
  console.log('🌐 [TUNNEL] Starting Cloudflare Tunnel...\n');
  
  const child = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:4000']);
  
  let urlExtracted = false;
  
  const extractUrl = (data) => {
    const output = data.toString();
    // Check for both standard output and error output as cloudflared often uses stderr for info
    const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    
    if (urlMatch && !urlExtracted) {
      urlExtracted = true;
      const url = urlMatch[0];
      
      console.log('\n✅ ========================================');
      console.log(`GraphQL Endpoint: ${url}/graphql`);
      console.log(`WebSocket Endpoint: ${url.replace('https://', 'wss://')}`);
      console.log('========================================\n');
      
      // Try to update the frontend config
      updateFrontendConfig(url);
    }
    return output;
  };

  child.stdout.on('data', (data) => {
    const output = extractUrl(data);
    process.stdout.write(`[TUNNEL] ${output}`);
  });
  
  child.stderr.on('data', (data) => {
    const output = extractUrl(data);
    process.stderr.write(`[TUNNEL OUT] ${output}`);
  });
  
  child.on('close', (code) => {
    console.log(`[TUNNEL] Process exited with code ${code}`);
  });
  
  process.on('SIGINT', () => {
    console.log('\n\n[TUNNEL] Shutting down tunnel...');
    child.kill();
    process.exit(0);
  });
}

async function updateFrontendConfig(url) {
  try {
    const configPath = resolve('/home/val/Projects/Shard/shard/config.ts');
    const config = `export const CONFIG = {
  GRAPHQL_ENDPOINT: '${url}/graphql',
};
`;
    
    await writeFile(configPath, config);
    console.log('✅ Frontend config updated: ' + configPath);
  } catch (error) {
    // Silently fail if can't update frontend
    console.log('ℹ️  Could not update frontend config:', error.message);
  }
}

startTunnel();
