import { CONSOLES, ConsoleDefinition, getConsoleById } from '../data/consoles';

export interface RomDetectionResult {
  status: 'detected' | 'ambiguous' | 'unrecognized';
  console: ConsoleDefinition | null;
  candidates: ConsoleDefinition[];
  confidence: 'alta' | 'media' | 'baixa';
  method: string;
  extension: string;
  fileName: string;
  fileSize: number;
  gameId: string;
  message: string;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) return '';
  let str = '';
  for (let i = 0; i < length; i++) {
    const code = bytes[offset + i];
    if (code >= 32 && code <= 126) {
      str += String.fromCharCode(code);
    }
  }
  return str;
}

function bytesMatch(bytes: Uint8Array, offset: number, pattern: number[]): boolean {
  if (offset + pattern.length > bytes.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (bytes[offset + i] !== pattern[i]) return false;
  }
  return true;
}

/**
 * Inspects inner filenames inside a .zip archive by parsing the End of Central Directory
 * from the tail of the file (reliable even when bit-3 data descriptors are used), with
 * fallback to local file headers.
 */
async function inspectZipEntries(file: File): Promise<string[]> {
  const names: string[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });

  // 1. Try End of Central Directory (last 65KB)
  const tailSize = Math.min(file.size, 65558);
  const tailStart = file.size - tailSize;
  const tailBuf = await file.slice(tailStart, file.size).arrayBuffer();
  const tail = new Uint8Array(tailBuf);

  let eocdPos = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (
      tail[i] === 0x50 &&
      tail[i + 1] === 0x4b &&
      tail[i + 2] === 0x05 &&
      tail[i + 3] === 0x06
    ) {
      eocdPos = i;
      break;
    }
  }

  if (eocdPos >= 0) {
    const cdSize =
      (tail[eocdPos + 12] |
        (tail[eocdPos + 13] << 8) |
        (tail[eocdPos + 14] << 16) |
        (tail[eocdPos + 15] << 24)) >>>
      0;
    const cdOffset =
      (tail[eocdPos + 16] |
        (tail[eocdPos + 17] << 8) |
        (tail[eocdPos + 18] << 16) |
        (tail[eocdPos + 19] << 24)) >>>
      0;

    if (cdSize > 0 && cdSize < 2 * 1024 * 1024 && cdOffset + cdSize <= file.size) {
      const cdBuf = await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer();
      const cd = new Uint8Array(cdBuf);
      let pos = 0;
      while (pos + 46 <= cd.length && names.length < 100) {
        if (
          cd[pos] === 0x50 &&
          cd[pos + 1] === 0x4b &&
          cd[pos + 2] === 0x01 &&
          cd[pos + 3] === 0x02
        ) {
          const nameLen = cd[pos + 28] | (cd[pos + 29] << 8);
          const extraLen = cd[pos + 30] | (cd[pos + 31] << 8);
          const commentLen = cd[pos + 32] | (cd[pos + 33] << 8);
          if (nameLen > 0 && pos + 46 + nameLen <= cd.length) {
            names.push(decoder.decode(cd.slice(pos + 46, pos + 46 + nameLen)));
          }
          pos += 46 + nameLen + extraLen + commentLen;
        } else {
          break;
        }
      }
      if (names.length > 0) return names;
    }
  }

  // 2. Fallback: scan local file headers (PK\x03\x04)
  const headSlice = await file.slice(0, Math.min(file.size, 262144)).arrayBuffer();
  const bytes = new Uint8Array(headSlice);
  let offset = 0;
  while (offset + 30 < bytes.length && names.length < 40) {
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x03 &&
      bytes[offset + 3] === 0x04
    ) {
      const nameLen = bytes[offset + 26] | (bytes[offset + 27] << 8);
      const extraLen = bytes[offset + 28] | (bytes[offset + 29] << 8);
      const compSize =
        (bytes[offset + 18] |
          (bytes[offset + 19] << 8) |
          (bytes[offset + 20] << 16) |
          (bytes[offset + 21] << 24)) >>>
        0;
      if (nameLen > 0 && offset + 30 + nameLen <= bytes.length) {
        names.push(decoder.decode(bytes.slice(offset + 30, offset + 30 + nameLen)));
      }
      const step = 30 + nameLen + extraLen + compSize;
      if (step <= 30) break;
      offset += step;
    } else {
      break;
    }
  }
  return names;
}

/**
 * Computes a deterministic game ID for IndexedDB 5-slot save states & per-game control profiles.
 */
export async function computeGameFingerprint(file: File): Promise<string> {
  const headBuffer = await file.slice(0, Math.min(file.size, 65536)).arrayBuffer();
  const tailStart = Math.max(0, file.size - 16384);
  const tailBuffer = await file.slice(tailStart, file.size).arrayBuffer();

  const metaEncoder = new TextEncoder();
  const metaBytes = metaEncoder.encode(`${file.name.toLowerCase()}::${file.size}::`);
  const combined = new Uint8Array(metaBytes.length + headBuffer.byteLength + tailBuffer.byteLength);
  combined.set(metaBytes, 0);
  combined.set(new Uint8Array(headBuffer), metaBytes.length);
  combined.set(new Uint8Array(tailBuffer), metaBytes.length + headBuffer.byteLength);

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Fallback FNV-1a 64-bit style hex
  let h1 = 0x811c9dc5;
  for (let i = 0; i < combined.length; i++) {
    h1 ^= combined[i];
    h1 = Math.imul(h1, 0x01000193);
  }
  return `${(h1 >>> 0).toString(16)}_${file.size}`;
}

export async function detectRomConsole(
  file: File,
  preferredConsoleId?: string
): Promise<RomDetectionResult> {
  const fileName = file.name;
  const lower = fileName.toLowerCase();
  const dotIdx = lower.lastIndexOf('.');
  const extension = dotIdx >= 0 ? lower.slice(dotIdx) : '';
  const gameId = await computeGameFingerprint(file);

  if (file.size === 0) {
    return {
      status: 'unrecognized',
      console: null,
      candidates: [],
      confidence: 'baixa',
      method: 'Arquivo vazio',
      extension: extension || '(sem extensão)',
      fileName,
      fileSize: 0,
      gameId,
      message: 'O arquivo selecionado está vazio (0 bytes). Selecione uma ROM válida.',
    };
  }

  // Read up to 128 KB from start for binary signature checks
  const headSize = Math.min(file.size, 131072);
  const headBuf = await file.slice(0, headSize).arrayBuffer();
  const bytes = new Uint8Array(headBuf);

  // 1. Check strong binary headers first (reliable even if extension is .bin or .rom)
  // NES iNES ("NES\x1a") or UNIF
  if (bytesMatch(bytes, 0, [0x4e, 0x45, 0x53, 0x1a]) || readAscii(bytes, 0, 4) === 'UNIF') {
    const nes = getConsoleById('nes')!;
    return {
      status: 'detected',
      console: nes,
      candidates: [nes],
      confidence: 'alta',
      method: 'Header binário iNES/UNIF',
      extension,
      fileName,
      fileSize: file.size,
      gameId,
      message: 'Assinatura iNES/UNIF detectada no cabeçalho da ROM.',
    };
  }

  // Nintendo 64 magic bytes (.z64, .v64, .n64)
  if (
    bytesMatch(bytes, 0, [0x80, 0x37, 0x12, 0x40]) ||
    bytesMatch(bytes, 0, [0x37, 0x80, 0x40, 0x12]) ||
    bytesMatch(bytes, 0, [0x40, 0x12, 0x37, 0x80])
  ) {
    const n64 = getConsoleById('n64')!;
    return {
      status: 'detected',
      console: n64,
      candidates: [n64],
      confidence: 'alta',
      method: 'Header binário N64 (PI_BSD_DOM1)',
      extension,
      fileName,
      fileSize: file.size,
      gameId,
      message: 'Assinatura de ROM Nintendo 64 identificada.',
    };
  }

  // Atari Lynx ("LYNX")
  if (bytesMatch(bytes, 0, [0x4c, 0x59, 0x4e, 0x58])) {
    const lynx = getConsoleById('lynx')!;
    return {
      status: 'detected',
      console: lynx,
      candidates: [lynx],
      confidence: 'alta',
      method: 'Header binário LYNX',
      extension,
      fileName,
      fileSize: file.size,
      gameId,
      message: 'Assinatura Atari Lynx detectada no cabeçalho.',
    };
  }

  // Atari 7800 ("ATARI7800")
  if (readAscii(bytes, 1, 9) === 'ATARI7800') {
    const a78 = getConsoleById('atari7800')!;
    return {
      status: 'detected',
      console: a78,
      candidates: [a78],
      confidence: 'alta',
      method: 'Header binário ATARI7800',
      extension,
      fileName,
      fileSize: file.size,
      gameId,
      message: 'Header oficial Atari 7800 identificado.',
    };
  }

  // Commodore Amiga ADF ("DOS\0".."DOS\5")
  if (bytes.length >= 4 && bytesMatch(bytes, 0, [0x44, 0x4f, 0x53]) && bytes[3] <= 7) {
    const amiga = getConsoleById('amiga')!;
    return {
      status: 'detected',
      console: amiga,
      candidates: [amiga],
      confidence: 'alta',
      method: 'Header de disquete AmigaDOS',
      extension,
      fileName,
      fileSize: file.size,
      gameId,
      message: 'Imagem de disquete AmigaDOS (.adf) reconhecida.',
    };
  }

  // Game Boy / Game Boy Color Nintendo Logo signature at 0x104
  const nintendoLogoPrefix = [0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b];
  if (bytesMatch(bytes, 0x104, nintendoLogoPrefix)) {
    const cgbFlag = bytes[0x143] ?? 0;
    const isColor = cgbFlag === 0x80 || cgbFlag === 0xc0 || extension === '.gbc';
    const target = getConsoleById(isColor ? 'gbc' : 'gb')!;
    return {
      status: 'detected',
      console: target,
      candidates: [target],
      confidence: 'alta',
      method: 'Logo Nintendo + Flag CGB (0x143)',
      extension,
      fileName,
      fileSize: file.size,
      gameId,
      message: isColor
        ? 'Header Game Boy Color identificado pela flag 0x143.'
        : 'Header Game Boy clássico identificado.',
    };
  }

  // Game Boy Advance Nintendo Logo at 0x04 and fixed value 0x96 at 0xB2
  if (bytesMatch(bytes, 0x04, [0x24, 0xff, 0xae, 0x51, 0x69, 0x9a, 0xa2, 0x21]) && bytes[0xb2] === 0x96) {
    const gba = getConsoleById('gba')!;
    return {
      status: 'detected',
      console: gba,
      candidates: [gba],
      confidence: 'alta',
      method: 'Header binário GBA (0x04/0xB2)',
      extension,
      fileName,
      fileSize: file.size,
      gameId,
      message: 'Assinatura oficial de cartucho Game Boy Advance detectada.',
    };
  }

  // Sega 32X vs Sega Mega Drive at 0x100
  const segaHeader100 = readAscii(bytes, 0x100, 16);
  if (segaHeader100.includes('SEGA 32X')) {
    const s32x = getConsoleById('sega32x')!;
    return {
      status: 'detected',
      console: s32x,
      candidates: [s32x],
      confidence: 'alta',
      method: 'Header SEGA 32X (0x100)',
      extension,
      fileName,
      fileSize: file.size,
      gameId,
      message: 'Header Sega 32X detectado no offset 0x100.',
    };
  }
  if (segaHeader100.includes('SEGA MEGA DRIVE') || segaHeader100.includes('SEGA GENESIS')) {
    const md = getConsoleById('segaMD')!;
    return {
      status: 'detected',
      console: md,
      candidates: [md],
      confidence: 'alta',
      method: 'Header SEGA MEGA DRIVE/GENESIS (0x100)',
      extension,
      fileName,
      fileSize: file.size,
      gameId,
      message: 'Header oficial Mega Drive / Genesis identificado.',
    };
  }

  // Sega Master System / Game Gear ("TMR SEGA" at 0x7FF0, 0x3FF0 or 0x1FF0)
  if (
    readAscii(bytes, 0x7ff0, 8) === 'TMR SEGA' ||
    readAscii(bytes, 0x3ff0, 8) === 'TMR SEGA' ||
    readAscii(bytes, 0x1ff0, 8) === 'TMR SEGA'
  ) {
    const isGG = extension === '.gg' || preferredConsoleId === 'segaGG';
    const target = getConsoleById(isGG ? 'segaGG' : 'segaMS')!;
    return {
      status: 'detected',
      console: target,
      candidates: [getConsoleById('segaMS')!, getConsoleById('segaGG')!],
      confidence: 'alta',
      method: 'Assinatura TMR SEGA',
      extension,
      fileName,
      fileSize: file.size,
      gameId,
      message: `Assinatura TMR SEGA encontrada (${target.name}).`,
    };
  }

  // Disc headers: Sega CD, Sega Saturn, PlayStation 1, PSP, 3DO
  const headerText = readAscii(bytes, 0, Math.min(bytes.length, 65536));
  if (headerText.includes('SEGADISCSYSTEM')) {
    const scd = getConsoleById('segaCD')!;
    return {
      status: 'detected',
      console: scd,
      candidates: [scd],
      confidence: 'alta',
      method: 'Header ISO SEGADISCSYSTEM',
      extension,
      fileName,
      fileSize: file.size,
      gameId,
      message: 'Imagem de disco Sega CD identificada.',
    };
  }
  if (headerText.includes('SEGA SEGASATURN')) {
    const sat = getConsoleById('segaSaturn')!;
    return {
      status: 'detected',
      console: sat,
      candidates: [sat],
      confidence: 'alta',
      method: 'Header ISO SEGA SEGASATURN',
      extension,
      fileName,
      fileSize: file.size,
      gameId,
      message: 'Imagem de disco Sega Saturn identificada.',
    };
  }
  if (headerText.includes('PSP GAME') || headerText.includes('UMD_DATA.BIN')) {
    const psp = getConsoleById('psp')!;
    return {
      status: 'detected',
      console: psp,
      candidates: [psp],
      confidence: 'alta',
      method: 'Header UMD PSP GAME',
      extension,
      fileName,
      fileSize: file.size,
      gameId,
      message: 'Imagem UMD de PlayStation Portable (PSP) detectada.',
    };
  }
  if (headerText.includes('PLAYSTATION') || headerText.includes('PS-X EXE') || headerText.includes('BOOT = cdrom:')) {
    const psx = getConsoleById('psx')!;
    return {
      status: 'detected',
      console: psx,
      candidates: [psx],
      confidence: 'alta',
      method: 'Header ISO9660 PLAYSTATION',
      extension,
      fileName,
      fileSize: file.size,
      gameId,
      message: 'Imagem de disco PlayStation 1 identificada.',
    };
  }
  if (bytesMatch(bytes, 0, [0x01, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a, 0x01])) {
    const tdo = getConsoleById('3do')!;
    return {
      status: 'detected',
      console: tdo,
      candidates: [tdo],
      confidence: 'alta',
      method: 'Assinatura OperaFS 3DO',
      extension,
      fileName,
      fileSize: file.size,
      gameId,
      message: 'Estrutura OperaFS de 3DO identificada.',
    };
  }

  // MSX Cartridge ROM ("AB")
  if (extension === '.rom' && bytes[0] === 0x41 && bytes[1] === 0x42) {
    const msx = getConsoleById('msx')!;
    return {
      status: 'detected',
      console: msx,
      candidates: [msx],
      confidence: 'alta',
      method: 'Header de cartucho MSX (AB)',
      extension,
      fileName,
      fileSize: file.size,
      gameId,
      message: 'Assinatura de cartucho MSX ("AB") detectada.',
    };
  }

  // DOOM IWAD / PWAD header
  const wadSig = readAscii(bytes, 0, 4);
  if (wadSig === 'IWAD' || wadSig === 'PWAD') {
    const doom = getConsoleById('doom')!;
    return {
      status: 'detected',
      console: doom,
      candidates: [doom],
      confidence: 'alta',
      method: `Header DOOM (${wadSig})`,
      extension,
      fileName,
      fileSize: file.size,
      gameId,
      message: `Arquivo ${wadSig} identificado para o motor DOOM (PrBoom).`,
    };
  }

  // 2. ZIP inspection (can be Arcade/MAME, FBNeo, MS-DOS or compressed console ROM)
  if (extension === '.zip') {
    const innerNames = await inspectZipEntries(file);
    const hasDosExe = innerNames.some((n) => {
      const l = n.toLowerCase();
      return l.endsWith('.exe') || l.endsWith('.com') || l.endsWith('.bat');
    });
    if (hasDosExe) {
      const dos = getConsoleById('dos')!;
      return {
        status: 'detected',
        console: dos,
        candidates: [dos],
        confidence: 'alta',
        method: 'Executáveis MS-DOS dentro do ZIP',
        extension,
        fileName,
        fileSize: file.size,
        gameId,
        message: 'Executável DOS (.exe/.com/.bat) encontrado no ZIP — usando núcleo MS-DOS (DOSBox Pure).',
      };
    }
    for (const inner of innerNames) {
      const innerLower = inner.toLowerCase();
      const innerDot = innerLower.lastIndexOf('.');
      const innerExt = innerDot >= 0 ? innerLower.slice(innerDot) : '';
      if (innerExt && innerExt !== '.bin' && innerExt !== '.rom') {
        const zipIds = new Set([
          'arcade',
          'mame2003',
          'fbneo',
          'fbalpha2012_cps1',
          'fbalpha2012_cps2',
          'fbalpha2012_cps3',
          'dos',
        ]);
        const matched = CONSOLES.filter(
          (c) => !zipIds.has(c.id) && c.extensions.includes(innerExt)
        );
        if (matched.length === 1) {
          return {
            status: 'detected',
            console: matched[0],
            candidates: matched,
            confidence: 'alta',
            method: `Conteúdo ZIP (${inner})`,
            extension,
            fileName,
            fileSize: file.size,
            gameId,
            message: `Arquivo "${inner}" dentro do ZIP identificado para ${matched[0].name}.`,
          };
        }
      }
    }
    const arcade = getConsoleById('arcade')!;
    const fbneo = getConsoleById('fbneo')!;
    if (preferredConsoleId && preferredConsoleId !== 'arcade') {
      const pref = getConsoleById(preferredConsoleId);
      if (pref) {
        return {
          status: 'detected',
          console: pref,
          candidates: [pref, arcade, fbneo],
          confidence: 'media',
          method: 'ZIP no emulador selecionado',
          extension,
          fileName,
          fileSize: file.size,
          gameId,
          message: `Arquivo compactado .zip será aberto no núcleo ${pref.name}.`,
        };
      }
    }
    return {
      status: 'detected',
      console: arcade,
      candidates: [arcade, fbneo],
      confidence: 'media',
      method: 'Pacote ROM Arcade/MAME (.zip)',
      extension,
      fileName,
      fileSize: file.size,
      gameId,
      message: 'Arquivo .zip identificado como romset Arcade (MAME / FinalBurn Neo). Altere abaixo se for MS-DOS ou outro sistema.',
    };
  }

  // 3. Extension-based lookup across all 45 consoles
  const matchingConsoles = CONSOLES.filter((c) => c.extensions.includes(extension));

  if (matchingConsoles.length === 1) {
    return {
      status: 'detected',
      console: matchingConsoles[0],
      candidates: matchingConsoles,
      confidence: 'alta',
      method: `Extensão exclusiva (${extension})`,
      extension,
      fileName,
      fileSize: file.size,
      gameId,
      message: `Formato ${extension} corresponde diretamente ao ${matchingConsoles[0].name}.`,
    };
  }

  if (matchingConsoles.length > 1) {
    // If user uploaded from a specific console page and it matches, prefer that one
    if (preferredConsoleId) {
      const prefMatch = matchingConsoles.find((c) => c.id === preferredConsoleId);
      if (prefMatch) {
        return {
          status: 'detected',
          console: prefMatch,
          candidates: matchingConsoles,
          confidence: 'media',
          method: `Extensão ${extension} + Console ativo`,
          extension,
          fileName,
          fileSize: file.size,
          gameId,
          message: `Extensão ${extension} é compartilhada, usando ${prefMatch.name} selecionado.`,
        };
      }
    }
    return {
      status: 'ambiguous',
      console: null,
      candidates: matchingConsoles,
      confidence: 'baixa',
      method: `Extensão compartilhada (${extension})`,
      extension,
      fileName,
      fileSize: file.size,
      gameId,
      message: `A extensão ${extension} é usada por ${matchingConsoles.length} consoles e o cabeçalho binário não foi conclusivo. Escolha manualmente o console correto.`,
    };
  }

  // 4. Unrecognized extension & no known binary header
  return {
    status: 'unrecognized',
    console: null,
    candidates: [],
    confidence: 'baixa',
    method: 'Não identificado',
    extension: extension || '(sem extensão)',
    fileName,
    fileSize: file.size,
    gameId,
    message: `Formato "${extension || 'desconhecido'}" não reconhecido automaticamente. Verifique se é uma ROM válida ou selecione o console manualmente se tiver certeza.`,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
