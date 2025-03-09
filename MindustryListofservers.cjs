const dgram = require('dgram');
const fsPromises = require('fs/promises');
const fs = require('fs');
const path = require('path');
const { Buffer } = require('buffer');

// ---------------------- 配置常量 ----------------------
const CLIENT_PORT = 65415; // 客户端绑定端口（抓包显示的源端口）
const REQUEST_DATA = Buffer.from([0xFE, 0x01]); // Mindustry 请求包数据
const SERVERS_FILE = path.join(__dirname, 'servers_v7.json'); // 服务器配置文件（新格式）
const RAW_FILE = path.join(__dirname, 'output.json');      // 存放未解析的原始元数据
const PARSED_FILE = path.join(__dirname, 'responses.json');  // 存放解析后的数据
const NO_RESPONSE_FILE = path.join(__dirname, 'serveip.json'); // 存放无响应服务器列表
const UDP_TIMEOUT = 30000; // UDP 收包等待时间（30秒）

// 增强数据处理相关配置
const config = {
  defaultPort: 6567,             // 默认端口
  colorTagRegex: /\[#?(\w+)\]/g,
  nameDescSeparator: '|',
  dateLocale: 'zh-CN'
};

// ---------------------- 服务器配置加载 ----------------------
/**
 * servers_v7.json 格式示例：
 * [
 *   {
 *     "name": "EscoCorp",
 *     "address": [
 *       "121.127.37.17:6567",
 *       "121.127.37.17:6568",
 *       "121.127.37.17"        // 未指定端口时默认使用 6567
 *     ]
 *   },
 *   { ... }
 * ]
 */
async function loadServers() {
  try {
    const data = await fsPromises.readFile(SERVERS_FILE, 'utf8');
    const serverGroups = JSON.parse(data);
    if (!Array.isArray(serverGroups)) {
      throw new Error('服务器配置格式错误，应为数组');
    }
    const servers = [];
    // 遍历每个服务器组，每个组可能包含多个地址
    serverGroups.forEach(group => {
      if (Array.isArray(group.address)) {
        group.address.forEach(addr => {
          let ip, port;
          if (addr.includes(':')) {
            [ip, port] = addr.split(':');
            port = parseInt(port);
          } else {
            ip = addr;
            port = config.defaultPort;
          }
          servers.push({ ip, port, name: group.name });
        });
      }
    });
    return servers;
  } catch (err) {
    console.error('读取服务器配置失败:', err);
    throw err;
  }
}

// ---------------------- UDP 请求与响应收集 ----------------------
async function sendUDPRequests() {
  return new Promise((resolve) => {
    const responses = {};
    const socket = dgram.createSocket('udp4');

    socket.bind(CLIENT_PORT, async () => {
      console.log(`UDP客户端已绑定端口 ${CLIENT_PORT}`);
      try {
        const servers = await loadServers();
        servers.forEach(server => {
          const key = `${server.ip}:${server.port}`;
          socket.send(REQUEST_DATA, server.port, server.ip, (err) => {
            if (err) {
              console.error(`发送到 ${key} 失败: ${err.message}`);
            } else {
              console.log(`已发送请求到 ${key}`);
            }
          });
        });
      } catch (err) {
        console.error('加载服务器配置失败:', err);
      }
    });

    socket.on('message', (msg, rinfo) => {
      const key = `${rinfo.address}:${rinfo.port}`;
      const hexData = msg.toString('hex'); // 以 16 进制格式保存
      console.log(`收到来自 ${key} 的响应`);
      // 如果同一服务器（key）多次响应，则以数组形式存储
      if (!responses[key]) {
        responses[key] = [];
      }
      responses[key].push({ timestamp: Date.now(), response: hexData });
    });

    socket.on('error', (err) => {
      console.error(`Socket错误: ${err.message}`);
    });

    // 等待 UDP_TIMEOUT 毫秒后关闭 socket，并返回收集到的响应数据
    setTimeout(() => {
      socket.close();
      console.log('UDP请求结束，关闭 socket');
      resolve(responses);
    }, UDP_TIMEOUT);
  });
}

// ---------------------- 增强型数据解析函数 ----------------------
// 对相同 key 的响应归组，然后保留最后一条作为最终结果，同时附带所有响应记录
async function processEnhancedData(inputData) {
  const groupedResults = {};
  // 将同一服务器的响应归为一组
  for (const key of Object.keys(inputData)) {
    // 如果存在多个响应，按时间戳排序，最后一条为最终结果
    const responsesArr = inputData[key].sort((a, b) => a.timestamp - b.timestamp);
    groupedResults[key] = {
      final: responsesArr[responsesArr.length - 1],
      all_responses: responsesArr
    };
  }

  const results = {};
  // 对每组取最终结果解析
  for (const [address, group] of Object.entries(groupedResults)) {
    const serverData = group.final;
    try {
      // 分离域名与端口
      const [domain, port] = address.split(':');
      const showPort = port && parseInt(port) !== config.defaultPort;
      // 时间戳验证
      const timestamp = validateTimestamp(serverData.timestamp);
      // 解析 16 进制数据（增强容错）
      const parsedData = parseHexPayload(serverData.response);
      // 分离名称和简介
      const [namePart, ...descParts] = parsedData.split(config.nameDescSeparator);
      const serverName = processColorTags((namePart || '未知服务器').trim());
      const description = processColorTags(descParts.join(config.nameDescSeparator).trim());
      // 生成键名：若端口为默认则只用域名，否则保留 ip:port
      results[showPort ? address : domain] = {
        name: serverName,
        description: description || '暂无描述',
        last_updated: formatTimestamp(timestamp),
        raw_hex: serverData.response,
        all_responses: group.all_responses // 附带所有响应记录
      };
    } catch (err) {
      results[address] = {
        name: '数据解析失败',
        description: `错误详情: ${err.message}`,
        last_updated: new Date().toLocaleString(config.dateLocale),
        raw_hex: serverData.response,
        all_responses: group.all_responses
      };
    }
  }
  return results;
}

// 16 进制数据解析函数
function parseHexPayload(hexString) {
  try {
    if (!/^[0-9a-fA-F]+$/.test(hexString)) {
      throw new Error('包含非16进制字符');
    }
    const buffer = Buffer.from(hexString, 'hex');
    return buffer.toString('utf8')
      .replace(/[\x00-\x1F\x7F-\x9F]/g, '') // 清除控制字符
      .replace(/\s+/g, ' ')
      .trim();
  } catch (err) {
    throw new Error(`HEX解析失败: ${err.message}`);
  }
}

// 时间戳验证
function validateTimestamp(ts) {
  if (typeof ts !== 'number' || ts < 0) {
    console.warn(`无效时间戳: ${ts}, 使用当前时间替代`);
    return Date.now();
  }
  return ts;
}

// 时间格式化
function formatTimestamp(ts) {
  try {
    return new Date(ts).toLocaleString(config.dateLocale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch {
    return new Date().toLocaleString(config.dateLocale);
  }
}

// 颜色标签处理
function processColorTags(text) {
  return text.replace(config.colorTagRegex, '{$1}');
}

// ---------------------- 解析 IP 数据并生成文件 ----------------------
// 此部分对每个响应生成单独的 JSON 文件，并在文件中增加一个更新时间字段
async function processIPResponses(responses) {
  // 将 responses 对象转换为数组，每个元素包含 ip、port 和 data（16进制字符串）
  const logs = [];
  for (const key of Object.keys(responses)) {
    // 对于同一 key 可能有多个响应，只取最后一个
    const [ip, port] = key.split(':');
    const arr = responses[key];
    const finalResponse = arr.sort((a, b) => a.timestamp - b.timestamp)[arr.length - 1];
    logs.push({ ip, port, data: finalResponse.response });
  }

  // 检查并创建 output 文件夹（存放每个 IP 的解析结果）
  const outputFolder = path.join(__dirname, 'output');
  if (!fs.existsSync(outputFolder)) {
    fs.mkdirSync(outputFolder, { recursive: true });
    console.log('文件夹已创建：', outputFolder);
  } else {
    console.log('文件夹已存在：', outputFolder);
  }

  const serveIpData = [];

  logs.forEach((log) => {
    try {
      // 将 16 进制字符串转换为 Buffer
      const msg = Buffer.from(log.data, 'hex');

      // 解析 IP 头部（Buffer.slice 返回 Buffer，需要转换为数组后 join）
      const ipHeader = {
        version: (msg[0] >> 4),
        headerLength: (msg[0] & 0x0F) * 4,
        totalLength: msg.readUInt16BE(2),
        ttl: msg[8],
        protocol: msg[9],
        sourceIP: Array.from(msg.slice(12, 16)).join('.'),
        destIP: Array.from(msg.slice(16, 20)).join('.')
      };

      // 解析 UDP 头部
      const udpHeaderOffset = ipHeader.headerLength;
      const udpHeader = {
        sourcePort: msg.readUInt16BE(udpHeaderOffset),
        destPort: msg.readUInt16BE(udpHeaderOffset + 2),
        length: msg.readUInt16BE(udpHeaderOffset + 4)
      };

      // 提取 Mindustry 数据部分
      const dataOffset = udpHeaderOffset + 8;
      const rawData = msg.slice(dataOffset);
      const messageText = rawData.toString('utf8');

      // 正则提取服务器简介
      const descriptionMatch = messageText.match(/\[gold\](.*?)\[acid\](.*?)(?=\u0000|$)/);
      const serverDescription = descriptionMatch
        ? (descriptionMatch[1].trim() + descriptionMatch[2].trim())
        : "未找到服务器简介";

      // 构造解析后的 JSON 数据，并增加更新时间字段
      const parsedData = {
        ipHeader,
        udpHeader,
        mindustryMessage: messageText,
        serverDescription,
        update_time: formatTimestamp(Date.now())
      };

      // 保存为每个 IP 对应的 JSON 文件（文件名：IP 中的点替换为破折号）
      const ipFileName = log.ip.replace(/\./g, '-') + '.json';
      const ipFilePath = path.join(outputFolder, ipFileName);
      fs.writeFileSync(ipFilePath, JSON.stringify(parsedData, null, 4), 'utf8');
      console.log(`Parsing complete. Results saved to ${ipFilePath}`);

      // 记录 serveIp 数据
      serveIpData.push({
        ip: log.ip,
        port: log.port,
        description: serverDescription
      });
    } catch (err) {
      console.error(`处理 ${log.ip}:${log.port} 时出错: ${err.message}`);
    }
  });

  // 保存所有 IP 数据到 serveip.json
  const serveIpFilePath = path.join(__dirname, 'serveip.json');
  fs.writeFileSync(serveIpFilePath, JSON.stringify(serveIpData, null, 4), 'utf8');
  console.log(`All IP information saved to ${serveIpFilePath}`);
}

// ---------------------- 主流程 ----------------------
async function main() {
  try {
    // 发送 UDP 请求并收集响应（所有响应以数组形式保存，便于保留最后一次及所有结果）
    const responses = await sendUDPRequests();

    // 1. 将未解析的原始响应数据写入 output.json
    await fsPromises.writeFile(RAW_FILE, JSON.stringify(responses, null, 2), 'utf8');
    console.log(`未解析的原始数据已写入 ${RAW_FILE}`);

    // 2. 对响应数据进行增强处理（保留每组的最后一条响应，同时附带所有响应），写入 responses.json
    const processedData = await processEnhancedData(responses);
    await fsPromises.writeFile(PARSED_FILE, JSON.stringify(processedData, null, 2), 'utf8');
    console.log(`解析后的数据已写入 ${PARSED_FILE}`);

    // 3. 解析 IP 数据，生成 individual JSON 文件，并生成无响应服务器列表（serveip.json）
    await processIPResponses(responses);

    // 4. 计算无响应的服务器列表：对比配置文件中所有服务器与实际收到响应的服务器
    const servers = await loadServers();
    // 此处采用每个地址构成的 key 进行判断（注意：在 sendUDPRequests 中，每个 key 为 "ip:port"）
    const responseKeys = new Set(Object.keys(responses));
    const noResponseServers = servers.filter(server => {
      const key = `${server.ip}:${server.port}`;
      return !responseKeys.has(key);
    });
    await fsPromises.writeFile(NO_RESPONSE_FILE, JSON.stringify(noResponseServers, null, 2), 'utf8');
    console.log(`无响应的服务器信息已写入 ${NO_RESPONSE_FILE}`);

  } catch (err) {
    console.error('全局错误:', err);
  }
}

// 定时执行（每30秒执行一次）
setInterval(main, UDP_TIMEOUT);
main(); // 立即执行一次
