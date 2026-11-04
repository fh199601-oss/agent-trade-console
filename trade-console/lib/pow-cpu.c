// Local Keccak-256 for a 52-byte packed (address,uint256) proof input.
// No wallet, network, or file access. Both JS digest checks and on-chain
// powValid must agree before a result can be used for a Mint preview.
#define _POSIX_C_SOURCE 200809L
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <inttypes.h>
#ifdef __APPLE__
#include <CommonCrypto/CommonDigest.h>
#endif
static const uint64_t rc[24]={
 0x0000000000000001ULL,0x0000000000008082ULL,0x800000000000808aULL,0x8000000080008000ULL,
 0x000000000000808bULL,0x0000000080000001ULL,0x8000000080008081ULL,0x8000000000008009ULL,
 0x000000000000008aULL,0x0000000000000088ULL,0x0000000080008009ULL,0x000000008000000aULL,
 0x000000008000808bULL,0x800000000000008bULL,0x8000000000008089ULL,0x8000000000008003ULL,
 0x8000000000008002ULL,0x8000000000000080ULL,0x000000000000800aULL,0x800000008000000aULL,
 0x8000000080008081ULL,0x8000000000008080ULL,0x0000000080000001ULL,0x8000000080008008ULL};
static const unsigned rot[25]={0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14};
static uint64_t rol(uint64_t a,unsigned n){return n?(a<<n)|(a>>(64-n)):a;}
static void digest(const unsigned char input[136],unsigned char out[32]){
 uint64_t a[25]={0},b[25],c[5],d[5];
 for(unsigned i=0;i<136;i++)a[i/8]|=(uint64_t)input[i]<<(8*(i%8));
 for(unsigned r=0;r<24;r++){
  for(unsigned x=0;x<5;x++)c[x]=a[x]^a[x+5]^a[x+10]^a[x+15]^a[x+20];
  for(unsigned x=0;x<5;x++)d[x]=c[(x+4)%5]^rol(c[(x+1)%5],1);
  for(unsigned y=0;y<5;y++)for(unsigned x=0;x<5;x++)a[x+5*y]^=d[x];
  for(unsigned y=0;y<5;y++)for(unsigned x=0;x<5;x++)b[y+5*((2*x+3*y)%5)]=rol(a[x+5*y],rot[x+5*y]);
  for(unsigned y=0;y<5;y++)for(unsigned x=0;x<5;x++)a[x+5*y]=b[x+5*y]^((~b[(x+1)%5+5*y])&b[(x+2)%5+5*y]);
  a[0]^=rc[r];
 }
 for(unsigned i=0;i<32;i++)out[i]=(unsigned char)(a[i/8]>>(8*(i%8)));
}
static double ms(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return t.tv_sec*1000.0+t.tv_nsec/1000000.0;}
static int hex(char c){if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;if(c>='A'&&c<='F')return c-'A'+10;return -1;}
static int number(const char *s,uint64_t *out){if(!s||!*s)return 0;for(const char*p=s;*p;p++)if(*p<'0'||*p>'9')return 0;char *end;*out=strtoull(s,&end,10);return !*end&&*out<=(1ULL<<63);}
int main(int argc,char **argv){
#ifdef __APPLE__
 if(argc==6&&!strcmp(argv[1],"--sha256-prefix")){
  const char *prefix=argv[2],*target=argv[3];size_t len=strlen(prefix);
  if(len<4||len>2050||len%2||strncmp(prefix,"0x",2)||strlen(target)!=66||strncmp(target,"0x",2))return 2;
  size_t size=(len-2)/2+32;unsigned char input[1056]={0},limit[32],out[32];
  for(size_t i=0;i<size-32;i++){int h=hex(prefix[2+i*2]),l=hex(prefix[3+i*2]);if(h<0||l<0)return 2;input[i]=(unsigned char)(h*16+l);}
  for(unsigned i=0;i<32;i++){int h=hex(target[2+i*2]),l=hex(target[3+i*2]);if(h<0||l<0)return 2;limit[i]=(unsigned char)(h*16+l);}
  uint64_t nonce,budget,attempts=0;if(!number(argv[4],&nonce)||!number(argv[5],&budget)||budget<1||budget>10000)return 2;
  int found=0;double began=ms();do{for(unsigned i=0;i<8;i++)input[size-1-i]=(unsigned char)(nonce>>(8*i));CC_SHA256(input,(CC_LONG)size,out);found=memcmp(out,limit,32)<=0;attempts++;nonce++;if(found)break;}while((attempts&16383)!=0||ms()-began<(double)budget);
  if(found)printf("{\"nonce\":\"%" PRIu64 "\",",nonce-1);else printf("{\"nonce\":null,");
  printf("\"next\":\"%" PRIu64 "\",\"attempts\":%" PRIu64 ",\"elapsedMs\":%.2f,\"backend\":\"local-prefix-sha256-cpu\"}\n",nonce,attempts,ms()-began);return 0;
 }
 if(argc==7&&!strcmp(argv[1],"--sha256")){
  const char *addr=argv[2],*challenge=argv[3],*target=argv[4];
  if(strlen(addr)!=42||strncmp(addr,"0x",2)||strlen(challenge)!=66||strncmp(challenge,"0x",2)||strlen(target)!=66||strncmp(target,"0x",2))return 2;
  unsigned char input[84]={0},limit[32],out[32];
  for(unsigned i=0;i<52;i++){const char *s=i<20?addr:challenge;unsigned j=i<20?i:i-20;int h=hex(s[2+j*2]),l=hex(s[3+j*2]);if(h<0||l<0)return 2;input[i]=(unsigned char)(h*16+l);}
  for(unsigned i=0;i<32;i++){int h=hex(target[2+i*2]),l=hex(target[3+i*2]);if(h<0||l<0)return 2;limit[i]=(unsigned char)(h*16+l);}
  uint64_t nonce,budget,attempts=0;if(!number(argv[5],&nonce)||!number(argv[6],&budget)||budget<1||budget>10000)return 2;
  int found=0;double began=ms();do{for(unsigned i=0;i<8;i++)input[83-i]=(unsigned char)(nonce>>(8*i));CC_SHA256(input,sizeof(input),out);found=memcmp(out,limit,32)<=0;attempts++;nonce++;if(found)break;}while((attempts&16383)!=0||ms()-began<(double)budget);
  if(found)printf("{\"nonce\":\"%" PRIu64 "\",",nonce-1);else printf("{\"nonce\":null,");
  printf("\"next\":\"%" PRIu64 "\",\"attempts\":%" PRIu64 ",\"elapsedMs\":%.2f,\"backend\":\"local-sha256-cpu\"}\n",nonce,attempts,ms()-began);return 0;
 }
#endif
 int hashOnly=argc==4&&!strcmp(argv[1],"--digest");if(!hashOnly&&argc!=5)return 2;
 const char *addr=argv[hashOnly?2:1];if(strlen(addr)!=42||strncmp(addr,"0x",2))return 2;
 unsigned char input[136]={0},out[32];for(unsigned i=0;i<20;i++){int h=hex(addr[2+i*2]),l=hex(addr[3+i*2]);if(h<0||l<0)return 2;input[i]=(unsigned char)(h*16+l);}input[52]=1;input[135]=128;
 uint64_t nonce,bits=0,budget=0;if(!number(argv[3],&nonce))return 2;
 if(!hashOnly&&(!number(argv[2],&bits)||bits<1||bits>40||!number(argv[4],&budget)||budget<1||budget>10000))return 2;
 double began=ms();uint64_t attempts=0;int found=0;
 do{
  for(unsigned i=0;i<8;i++)input[51-i]=(unsigned char)(nonce>>(8*i));digest(input,out);
  if(hashOnly){for(unsigned i=0;i<32;i++)printf("%02x",out[i]);puts("");return 0;}
  found=1;for(unsigned i=0;i<bits/8;i++)if(out[i])found=0;
  if(bits%8&&(out[bits/8]>>(8-bits%8)))found=0;
  attempts++;nonce++;if(found)break;
 }while(attempts<64000000&&((attempts&16383)!=0||ms()-began<(double)budget));
 if(found)printf("{\"nonce\":\"%" PRIu64 "\",",nonce-1);else printf("{\"nonce\":null,");
 printf("\"next\":\"%" PRIu64 "\",\"attempts\":%" PRIu64 ",\"elapsedMs\":%.2f,\"backend\":\"local-cpu\"}\n",nonce,attempts,ms()-began);return 0;
}
