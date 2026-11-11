`encrypted.pdf` is the five-page sample from `sample.ts`, AES-256 encrypted
(user password `secret`, owner password `own`). Regenerate with:

```bash
python3 -c "import pikepdf; pikepdf.open('sample.pdf').save('encrypted.pdf', encryption=pikepdf.Encryption(owner='own', user='secret', R=6))"
```
