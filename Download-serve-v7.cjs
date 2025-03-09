const https = require('https');
const fs = require('fs');

const url = 'https://raw.githubusercontent.com/Anuken/Mindustry/master/servers_v7.json';
const filePath = 'servers_v7.json';

function downloadFile() {
  https.get(url, (res) => {
    if (res.statusCode !== 200) {
      console.error(`下载失败，状态码：${res.statusCode}`);
      res.resume();
      return;
    }
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      fs.writeFile(filePath, data, (err) => {
        if (err) {
          console.error('写入文件错误:', err);
        } else {
          console.log(`文件已保存到 ${filePath}，更新时间：${new Date().toLocaleString()}`);
        }
      });
    });
  }).on('error', (e) => {
    console.error(`请求错误: ${e.message}`);
  });
}

// 初次下载
downloadFile();
// 每隔1小时（3600000毫秒）执行一次下载任务
setInterval(downloadFile, 3600000);
