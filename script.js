const address = '青海省玉树州囊谦县 卡秀商务酒店（阿育王塔店）';
const toast = document.getElementById('toast');

async function copyAddress() {
  try {
    await navigator.clipboard.writeText(address);
  } catch (_) {
    const input = document.createElement('textarea');
    input.value = address;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 1800);
}

document.getElementById('copyAddress').addEventListener('click', copyAddress);
document.getElementById('mobileCopy').addEventListener('click', copyAddress);
