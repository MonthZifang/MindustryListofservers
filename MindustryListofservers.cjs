
// ---------------------- 依赖检查 ----------------------
const { spawnSync } = require('child_process');


function ensureDependency(moduleName) {
  try {
    require.resolve(moduleName);
    return true;
  } catch {
    console.log(`检测到缺少依赖模块 "${moduleName}"，尝试自动安装...`);
    const result = spawnSync('npm', ['install', moduleName], {
      stdio: 'inherit',
      shell: true
    });
    if (result.status !== 0) {
      console.error(`自动安装 "${moduleName}" 失败，请手动执行: npm install ${moduleName}`);
      process.exit(1);
    } else {
      console.log(`模块 "${moduleName}" 安装成功。`);
      return true;
    }
  }
}
// 检查并安装关键依赖
ensureDependency('ping');


const https = require('https');
const fs = require('fs');
const dgram = require('dgram');
const path = require('path');
const ping = require('ping');
const { Buffer } = require('buffer');

// ---------------------- 配置 ----------------------
const SERVER_LIST_URLS = [
  'https://raw.githubusercontent.com/Anuken/Mindustry/master/servers_v7.json',
  'https://cdn.staticaly.com/gh/Anuken/Mindustry/master/servers_v7.json',
  'https://github.moeyy.xyz/https://github.com/Anuken/Mindustry/blob/master/servers_v7.json'
];

const SERVER_LIST_PATH = path.join(__dirname, 'servers_v7.json');
const RAW_FILE = path.join(__dirname, 'raw_responses.json');
const PARSED_FILE = path.join(__dirname, 'servers.json');
const CLIENT_PORT = 65415;
const REQUEST_DATA = Buffer.from([0xFE, 0x01]);
const UDP_TIMEOUT = 30000;

const config = {
  defaultPort: 6567,
  colorTagRegex: /\[([a-z0-9#]+)\]/g,
  nameDescSeparator: '|',
  dateLocale: 'zh-CN'
};


// ---------------------- 下载服务器列表 ----------------------
async function downloadServerList() {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 5000;

  for (let urlIndex = 0; urlIndex < SERVER_LIST_URLS.length; urlIndex++) {
    const url = SERVER_LIST_URLS[urlIndex];
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`尝试从源 ${urlIndex + 1} 下载（尝试 ${attempt}/${MAX_RETRIES}）...`);
        const data = await new Promise((resolve, reject) => {
          https.get(url, (res) => {
            if (res.statusCode !== 200) {
              reject(new Error(`状态码 ${res.statusCode}`));
              res.resume();
              return;
            }

            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              fs.writeFile(SERVER_LIST_PATH, data, (err) => {
                if (err) reject(err);
                else resolve(data);
              });
            });
          }).on('error', reject);
        });

        console.log(`从源 ${urlIndex + 1} 下载成功`);
        return data;

      } catch (err) {
        console.error(`下载源 ${urlIndex + 1} 尝试 ${attempt}/${MAX_RETRIES} 失败: ${err.message}`);
        if (attempt < MAX_RETRIES) {
          await new Promise(res => setTimeout(res, RETRY_DELAY));
        }
      }
    }
  }

  throw new Error('所有下载源都失败');
}

// ---------------------- 加载服务器地址 ----------------------
async function loadServers() {
  try {
    const data = await fs.promises.readFile(SERVER_LIST_PATH, 'utf8');
    const serverGroups = JSON.parse(data);

    if (!Array.isArray(serverGroups)) throw new Error('服务器配置格式错误');

    const servers = [];
    serverGroups.forEach(group => {
      if (Array.isArray(group.address)) {
        group.address.forEach(addr => {
          let [host, port] = addr.includes(':') ? addr.split(':') : [addr, config.defaultPort];
          servers.push({ host, port: parseInt(port), name: group.name });
        });
      }
    });
    return servers;
  } catch (err) {
    console.error('读取服务器配置失败:', err.message);
    return [];
  }
}

// ---------------------- 发送UDP请求，保留域名作为key ----------------------
async function sendUDPRequests(servers) {
  return new Promise((resolve) => {
    const responses = {};
    const socket = dgram.createSocket('udp4');

    socket.bind(CLIENT_PORT, () => {
      console.log(`UDP客户端已绑定端口 ${CLIENT_PORT}`);

      if (servers.length === 0) {
        console.log('没有可用的服务器进行探测');
        socket.close();
        resolve(responses);
        return;
      }

      // 发送请求并记录映射
      const hostPortMap = {};

      servers.forEach(server => {
        const key = `${server.host}:${server.port}`;
        hostPortMap[`${server.host}:${server.port}`] = key; // 域名或 IP 保留
        socket.send(REQUEST_DATA, server.port, server.host, (err) => {
          if (err) console.error(`发送到 ${key} 失败: ${err.message}`);
          else console.log(`已发送请求到 ${key}`);
        });
      });

      socket.on('message', (msg, rinfo) => {
        const ipKey = `${rinfo.address}:${rinfo.port}`;
        const matchedKey = Object.keys(hostPortMap).find(k => k.endsWith(`:${rinfo.port}`)) || ipKey;

        const hexData = msg.toString('hex');
        console.log(`收到来自 ${matchedKey} 的响应`);
        if (!responses[matchedKey]) responses[matchedKey] = [];
        responses[matchedKey].push({ timestamp: Date.now(), response: hexData });
      });

      socket.on('error', (err) => {
        console.error(`Socket错误: ${err.message}`);
      });

      setTimeout(() => {
        socket.close();
        console.log('UDP请求结束');
        resolve(responses);
      }, UDP_TIMEOUT);
    });
  });
}

// ---------------------- 数据解析 ----------------------


function processColorTags(text) {
  return text.replace(config.colorTagRegex, '{$1}');
}

function parseServerInfo(hexString) {
  let local_name = '未知服务器', local_description = '未知', local_players = '未知', local_map = '未知地图';

  const buf = Buffer.from(hexString, 'hex')

  let str = "0";
  str = buf.toString('utf-8');

  const nameLenth = buf.readUInt8(0);
  const mapLenth = buf.readUInt8(nameLenth + 1);
  const subHex = buf.slice(nameLenth + 1 + mapLenth + 1, 12);
  const officalLenth = buf.readUInt8(nameLenth + 1 + mapLenth + 1 + 12);
  const sub2Hex = buf.slice(nameLenth + 1 + mapLenth + 1 + 12 + officalLenth + 1, 6);
  const descriptionLenth = buf.readInt8(nameLenth + 1 + mapLenth + 1 + 12 + officalLenth + 1 - 1 + 6);
  const sub3Hex = buf.slice(nameLenth + 1 + mapLenth + 1 + 12 + officalLenth + 1 + 6 + descriptionLenth + 1 - 1, 3);

  local_name = buf.toString('utf-8', 1, nameLenth - 1).replace("[]", " ");
  local_map = buf.toString('utf-8', nameLenth + 2, nameLenth + 2 + mapLenth).replace("[]", " ");
  local_players = buf.readUint8(nameLenth + 2 + mapLenth + 1 + 2);
  local_description = buf.toString('utf-8', nameLenth + 1 + mapLenth + 1 + 12 + officalLenth + 1 - 1 + 6 + 1,  nameLenth + 1 + mapLenth + 1 + 12 + officalLenth + 1 - 1 + 6 + 1 + descriptionLenth).replace("[]", " ");

  
/*
  const playersMatch = parsed.match(/(\d+)\s*\/\s*(\d+)/);
  if (playersMatch) players = `${playersMatch[1]}/${playersMatch[2]}`;

  const mapMatch = parsed.match(/(?:地图|map)[:：]\s*([^\s\]]+)/i);
  if (mapMatch) map = mapMatch[1];

  const nameEndIndex = parsed.indexOf('[');
  if (nameEndIndex > 0) {
    name = parsed.substring(0, nameEndIndex).trim();
    description = parsed.substring(nameEndIndex);
  }

  const specialTags = [
    { regex: /\[gold\]/g, replace: '{gold}' },
    { regex: /\[acid\]/g, replace: '{acid}' },
    { regex: /\[sky\]/g, replace: '{sky}' },
    { regex: /\[white\]/g, replace: '{white}' },
    { regex: /\[tan\]/g, replace: '{tan}' },
    { regex: /\[red\]/g, replace: '{red}' },
    { regex: /\[yellow\]/g, replace: '{yellow}' },
    { regex: /\[lime\]/g, replace: '{lime}' },
    { regex: /\[stat\]/g, replace: '{stat}' }
  ];

  specialTags.forEach(tag => {
    description = description.replace(tag.regex, tag.replace);
  });

  description = description.replace(/\s{2,}/g, ' ').trim();
*/
  return {
    name: processColorTags(local_name),
    description: processColorTags(local_description),
    players: local_players,
    map: processColorTags(local_map)
  };
}

// ---------------------- 整合处理+Ping ----------------------
async function processEnhancedData(inputData) {
  const servers = [];

  for (const [address, responses] of Object.entries(inputData)) {
    try {
      const latest = responses.sort((a, b) => b.timestamp - a.timestamp)[0];
      //const rawText = parseHexPayload(latest.response);
      const { name, description, players, map } = parseServerInfo(latest.response);

      const [host, port] = address.split(':');
      const displayAddress = port && parseInt(port) !== config.defaultPort ? `${host}:${port}` : host;

      // Ping 测试
      let pingResult = '未知';
      try {
        const res = await ping.promise.probe(host, { timeout: 2 });
        pingResult = res.alive ? `${res.time}ms` : '超时';
      } catch {
        pingResult = '错误';
      }

      servers.push({
        ip: displayAddress,
        name,
        players,
        map,
        description,
        ping: pingResult,
        updatedAt: new Date(latest.timestamp).toLocaleString(config.dateLocale, {
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit'
        }).replace(/\//g, '-'),
        sentPackets: responses.length,
        receivedMeta: latest.response.length / 2
      });

    } catch (err) {
      console.error(`处理 ${address} 时出错: ${err.message}`);
      servers.push({
        ip: address,
        name: '数据解析失败',
        players: '未知',
        map: '未知地图',
        description: '解析失败',
        ping: "未知",
        updatedAt: new Date().toLocaleString(config.dateLocale),
        sentPackets: 0,
        receivedMeta: 0
      });
    }
  }

  return { servers };
}

// ---------------------- 主逻辑 ----------------------
async function main() {
  try {
    let servers = [];

    try {
      servers = await loadServers();
      console.log(`从本地加载了 ${servers.length} 个服务器`);
    } catch {
      console.log('本地服务器列表不可用，尝试下载...');
    }

    if (servers.length === 0) {
      try {
        console.log('下载服务器列表文件...');
        await downloadServerList();
        servers = await loadServers();
        if (servers.length === 0) throw new Error('下载后仍为空');
        console.log(`下载成功，加载了 ${servers.length} 个服务器`);
      } catch (err) {
        console.error('无法获取有效服务器列表，已终止任务: ', err.message);
        return;
      }
    }

    const responses = await sendUDPRequests(servers);
    await fs.promises.writeFile(RAW_FILE, JSON.stringify(responses, null, 2));
    console.log(`原始响应数据已保存: ${RAW_FILE}`);

    const parsedData = await processEnhancedData(responses);
    await fs.promises.writeFile(PARSED_FILE, JSON.stringify(parsedData, null, 2));
    console.log(`解析后的服务器数据已保存: ${PARSED_FILE}`);
    console.log(`共发现 ${parsedData.servers.length} 个服务器`);

  } catch (err) {
    console.error('全局错误:', err.message);
  }
}


// ---------------------- 替换符号 ----------------------
function fixBrackets() {
  const filePath = path.join(__dirname, 'servers.json');

  let json;
  try {
    json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error(' 读取 JSON 失败:', e.message);
    return;
  }

  if (json.servers && Array.isArray(json.servers)) {
    json.servers = json.servers.map(server => {
      if (typeof server.name === 'string') {
        server.name = server.name.replace(/\[([#0-9A-Fa-f]+)\]/g, '{$1}');
      }
      if (typeof server.description === 'string') {
        server.description = server.description.replace(/\[([#0-9A-Fa-f]+)\]/g, '{$1}');
      }
      return server;
    });

    fs.writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf8');
    console.log('✨ 后置处理完成：已替换 name/description 中的 [ ] → { }');
  }
}

// ---------------------- 执行 ----------------------
async function run() {
  await main(); // 等主程序执行完
  fixBrackets(); // 然后执行后置处理
  setInterval(async () => {
    await main();
    fixBrackets();
  }, 5 * 60 * 1000); // 每 5 分钟循环
}

run(); 


//console.log(parseServerInfo('4aef9dbd5b236666326130305de6a2a65b236234316530305de9ad945b233738313430305de79fad5b233530306430305de7a5b75b5def9dbd5b77686974655d20e4b8bbe69c8d20eea1a1205be59b9ee6a1a3315d5b6f72616e67655de587a0e68a8ae78cabe5a194e998b200000012000000ba00000096086f6666696369616c00000000004a5b676f6c645de69a91e58187e6b4bbe58aa8e5bc80e590afefbc815b6f72616e67655de88eb7e58f96e6b4bbe58aa8e8b4a7e5b881e8a7a3e99481e8a5bfe7939ce5aea0e789a9efbc810019a7'));
