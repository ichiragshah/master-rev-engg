const CryptoJS = require('crypto-js');

const SECRET = process.env.CRYPTO_SECRET;

function encrypt(plaintext) {
  if (!SECRET) throw new Error('CRYPTO_SECRET not set');
  return CryptoJS.AES.encrypt(plaintext, SECRET).toString();
}

function decrypt(ciphertext) {
  if (!SECRET) throw new Error('CRYPTO_SECRET not set');
  const bytes = CryptoJS.AES.decrypt(ciphertext, SECRET);
  return bytes.toString(CryptoJS.enc.Utf8);
}

module.exports = { encrypt, decrypt };
