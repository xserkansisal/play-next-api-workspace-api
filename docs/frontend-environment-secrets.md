# Frontend entegrasyonu: gizli environment değişkenleri

Bu doküman, environment değişkenlerini oluşturma, görüntüleme, düzenleme ve collection run sırasında
kullanma akışını açıklar. Genel API kuralları ve team context için
[Frontend API Reference](./frontend-api-reference.md#13-environments-apiv1environments), collection
run yanıtı ve geçmişi için [Collection runner](./frontend-collection-runner.md) dokümanına bakın.

## Veri modeli

```ts
type EnvironmentVariable = {
  key: string;
  value: string;
  enabled: boolean;
  isSecret: boolean;
};

type Environment = {
  id: string;
  name: string;
  variables: EnvironmentVariable[]; // position sırası
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
};
```

`isSecret` yeni değişkenlerde gönderilmezse `false` olur. Alan, değerin gizli olarak sınıflandırıldığını
belirtir; **değeri API yanıtlarından gizlemez**. Yetkili `GET /api/v1/environments` ve
`GET /api/v1/environments/:environmentId` istekleri gerçek `value` değerlerini döndürür. İstemci,
`isSecret: true` değerlerini arayüzde varsayılan olarak maskeli göstermeli ve açığa çıkarma eylemini
kullanıcı kontrolüne bırakmalıdır.

Environment değerlerinin tamamı sunucu tarafında şifreli saklanır. Şifreleme/anahtar yönetimi
frontend'in sorumluluğunda değildir; değerleri API'ye normal metin olarak gönderin.

## İsteklerde team ve session bilgisi

İsteklerde oturum cookie'sini dahil edin (`credentials: "include"` / `withCredentials: true`) ve
team'e bağlı endpoint'lerde `X-Team-Id: <teamId>` gönderin. Birden fazla team üyesi olan kullanıcıda
team header'ı zorunludur. Okumalar `viewer`, yazmalar `member` veya üstü rol gerektirir.

## Oluşturma ve düzenleme

Bir environment oluştururken `isSecret` alanını gizli olarak işaretlenen değişkenlerle birlikte
gönderin:

```http
POST /api/v1/environments
Content-Type: application/json
X-Team-Id: <teamId>
```

```json
{
  "name": "Production",
  "variables": [
    { "key": "baseUrl", "value": "https://api.example.com", "enabled": true },
    { "key": "ACCESS_TOKEN", "value": "token-value", "enabled": true, "isSecret": true }
  ]
}
```

Yanıt `201` ile oluşturulan environment'ı döndürür; yanıttaki `value` alanları gerçek değerlerdir.
Değişken eklemek için `POST /api/v1/environments/:environmentId/variables` kullanabilirsiniz; bu
isteğin gövdesi `{ "key": "...", "value": "...", "enabled": true, "isSecret": true }` biçimindedir.
`enabled` ve `isSecret` isteğe bağlıdır; varsayılanları sırasıyla `true` ve `false` değerleridir.

`PUT /api/v1/environments/:environmentId` environment'ın adını ve **tüm değişken listesini** değiştirir:

```json
{
  "name": "Production",
  "variables": [
    { "key": "baseUrl", "value": "https://api.example.com", "enabled": true, "isSecret": false },
    { "key": "ACCESS_TOKEN", "value": "token-value", "enabled": true, "isSecret": true }
  ]
}
```

Bu nedenle düzenleme formu listeyi kaydederken her değişkenin `isSecret` değerini korumalı ve gizli
değerlerin yerine maske karakterleri göndermemelidir. Maske metnini (`••••••`, `******` vb.) gerçek
değerin yerine gönderirseniz sunucu bunu yeni değer olarak kaydeder. UI gizli değerin değişmediğini
anlatan bir gösterim kullanıyorsa, kaydetme payload'ında son `GET` yanıtından gelen gerçek değeri
koruyun veya değişiklikleri gönderme modelinde gerçek değerle görsel maskeyi ayrı tutun.

Klonlama (`POST /api/v1/environments/:environmentId/clone`) gizlilik işaretlerini ve değerleri
koruyarak yeni environment oluşturur. Trash'ten geri yüklenen environment da değişken metadata'sını
korur.

## Collection run ve hassas çıktı

`POST /api/v1/collections/:collectionId/run` veya folder run isteğine seçili environment'ı verin:

```json
{ "environmentId": "<environmentId>" }
```

Sunucu, enabled environment değerlerini çözer ve `{{key}}` referanslarını istek yürütmesinde kullanır.
Gizli değişkenin değeri ayrıca run yanıtındaki ve run geçmişindeki kaydedilmiş `responsePreview`
alanlarından maskelenir. `isSecret: true` değişkenlere ek olarak hassas ad desenleriyle eşleşen
anahtarlar (ör. `token`, `secret`, `password`, `apiKey`, `authorization`, `cookie`) da maskeleme
kapsamındadır.

Bu maskeleme yalnızca kaydedilen önizleme içindir; runner'ın gerçek upstream isteğini veya script
API'sini değiştirmez. Önizlemeyi UI'da gösterirken `responsePreview` değerini olduğu gibi kullanın;
değişken değerlerini frontend loglarına, analytics/event payload'larına veya hata raporlarına
eklemeyin. Yanıt önizlemeleri gizli olmayan hassas upstream veriler de içerebileceğinden, genel
olarak hassas veri kabul edilmelidir.

OpenAPI dışa aktarma environment değerlerini içermez. Environment değerlerini koleksiyon,
değişiklik önizlemesi veya telemetry verilerine kopyalamayın.

## Doğrulama ve hatalar

- Değişken anahtarı 1–256 karakter olmalı; boşluk ve `{}` içeremez.
- Değer en fazla 65.536 karakter olabilir.
- Bir environment içinde aynı anahtara sahip birden fazla **enabled** değişken olamaz; disabled
  değişkenlerde aynı anahtar kullanılabilir.
- En fazla 1.000 değişken bulunabilir.
- Başarısız doğrulama `400 VALIDATION_ERROR`; yetkisiz rol `403 TEAM_ROLE_REQUIRED`; aynı enabled
  anahtarı ekleme `409 VARIABLE_KEY_EXISTS`; limit aşımı `422 VARIABLE_LIMIT_REACHED` döndürür.
- Environment listesindeki/tekil yanıttaki değer çözümlenemiyorsa sunucu bunu boş değer veya maske
  ile değiştirmez; istek hata verir. İstemci bu yanıtı başarılı veri olarak önbelleğe almamalıdır.
