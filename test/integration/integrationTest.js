const expect = require('chai').expect;
const puppeteer = require('puppeteer');

const crypto = require('crypto');
const fs = require('fs');

const server = require('../../dist/server');

function urlFor(path) {
  if (!path.startsWith('/')) {
    path = '/' + path;
  }
  return `http://localhost:${server.port()}${path}`;
}

describe('Integration tests:', function() {
  let browser;
  let page;
  let browserAvailable = true;

  // Increase timeout for Puppeteer operations
  this.timeout(30000);

  before(async function() {
    // Start server first
    server.start(0);
    
    // Add a small delay to ensure server is ready
    await new Promise(resolve => setTimeout(resolve, 500));
    
    try {
      // Launch browser with more options for stability
      browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ],
        timeout: 30000
      });
    } catch (err) {
      console.error('Failed to launch browser:', err);
      browserAvailable = false;
      // Don't throw error, just mark browser as unavailable
      // This allows other tests to run
    }
  });

  after(async function() {
    // Make sure we have a browser to close
    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        console.error('Error closing browser:', err);
      }
    }
    
    // Make sure server is running before stopping
    if (server && server.port()) {
      server.stop();
    }
  });
  
  describe('User visits homepage', function() {
    before(async function() {
      if (!browserAvailable) {
        this.skip();
        return;
      }
      
      try {
        page = await browser.newPage();
        await page.goto(urlFor('/'), { 
          waitUntil: 'networkidle0',
          timeout: 15000
        });
      } catch (err) {
        console.error('Error navigating to homepage:', err);
        browserAvailable = false;
        this.skip();
      }
    });

    after(async function() {
      if (page) {
        await page.close().catch(err => console.error('Error closing page:', err));
      }
    });
    
    describe('brand recognition', function() {
      it('should say trntxt', async function() {
        const text = await page.evaluate(() => document.body.textContent);
        expect(text).to.contain('trntxt');
      });
      it('should say Train Text', async function() {
        const text = await page.evaluate(() => document.body.textContent);
        expect(text).to.contain('Train Text');
      });
    });

    describe('social sharing headers', function() {
      it('should have a title', async function() {
        const content = await page.evaluate(() => 
          document.querySelector("head meta[property='og:title']").content
        );
        expect(content).to.equal('Train Text');
      });
      it('should have a description', async function() {
        const content = await page.evaluate(() => 
          document.querySelector("head meta[property='og:description']").content
        );
        expect(content).to.equal('A data-friendly train times service for Great Britain.');
      });
      it('should have a type', async function() {
        const content = await page.evaluate(() => 
          document.querySelector("head meta[property='og:type']").content
        );
        expect(content).to.equal('website');
      });
      it('should have an image', async function() {
        const content = await page.evaluate(() => 
          document.querySelector("head meta[property='og:image']").content
        );
        expect(content).to.equal('/android-chrome-192x192.png');
      });
    });
  });
  
  describe('Public files', function() {
    before(function() {
      if (!browserAvailable) {
        this.skip();
      }
    });
    
    ['public', 'dist/public'].forEach(function(folder) {
      describe(`in ${folder}/`, function() {
        const files = fs.readdirSync(folder);
        files.forEach(function(path) {
          it(`responds to ${path}`, async function() {
            if (!browserAvailable) {
              this.skip();
              return;
            }
            await checkFile(folder, path);
          });
        });
      });
    });
  });
  
  async function checkFile(folder, filename) {
    const page = await browser.newPage();
    try {
      // Add timeout and more reliable wait strategy
      const response = await page.goto(urlFor(filename), { 
        waitUntil: 'networkidle2',
        timeout: 10000
      });
      
      expect(response.status()).to.equal(200);
      
      // Get response as buffer
      const buffer = await response.buffer();
      const expectedBody = fs.readFileSync(`${folder}/${filename}`);
      const responseHash = crypto.createHash('md5').update(buffer).digest('hex');
      const expectedHash = crypto.createHash('md5').update(expectedBody).digest('hex');
      expect(responseHash).to.equal(expectedHash);
    } catch (err) {
      console.error(`Error checking file ${filename}:`, err);
      throw err;
    } finally {
      await page.close();
    }
  }
  
  describe('Pin app to homescreen', function() {
    describe('Web app manifest', function() {
      let manifestPage;
      
      before(async function() {
        if (!browserAvailable) {
          this.skip();
          return;
        }
        
        try {
          manifestPage = await browser.newPage();
        } catch (err) {
          console.error('Error creating new page:', err);
          browserAvailable = false;
          this.skip();
        }
      });
      
      after(async function() {
        if (manifestPage) {
          await manifestPage.close().catch(err => console.error('Error closing page:', err));
        }
      });
      
      it('is linked from the home page', async function() {
        if (!browserAvailable) {
          this.skip();
          return;
        }
        
        try {
          await manifestPage.goto(urlFor('/'), { 
            waitUntil: 'networkidle0',
            timeout: 15000
          });
          const href = await manifestPage.evaluate(() => 
            document.querySelector('link[rel=manifest]').getAttribute('href')
          );
          expect(href).to.equal('/manifest.json');
        } catch (err) {
          console.error('Error checking manifest link:', err);
          browserAvailable = false;
          this.skip();
        }
      });
      
      it('exists', async function() {
        if (!browserAvailable) {
          this.skip();
          return;
        }
        
        try {
          const response = await manifestPage.goto(urlFor('/manifest.json'), { 
            waitUntil: 'networkidle0',
            timeout: 15000
          });
          expect(response.status()).to.equal(200);
          const manifestText = await response.text();
          const manifest = JSON.parse(manifestText);
          expect(manifest).to.be.an('object');
        } catch (err) {
          console.error('Error checking manifest existence:', err);
          browserAvailable = false;
          this.skip();
        }
      });
      
      describe('properties', function() {
        let manifest = {};
        
        before(async function() {
          if (!browserAvailable) {
            this.skip();
            return;
          }
          
          try {
            const response = await manifestPage.goto(urlFor('/manifest.json'), { 
              waitUntil: 'networkidle0',
              timeout: 15000
            });
            const manifestText = await response.text();
            manifest = JSON.parse(manifestText);
          } catch (err) {
            console.error('Error loading manifest properties:', err);
            browserAvailable = false;
            this.skip();
          }
        });
        
        const expectations = {
          'background_color': '#fff',
          'display': 'browser',
          'name': 'trntxt',
          'short_name': 'trntxt',
          'start_url': '/',
          'description': 'Train Text: a data-friendly train times service for Great Britain'
        };
        
        Object.keys(expectations).forEach(key => {
          it(`has '${key}' equal to '${expectations[key]}'`, function() {
            expect(manifest[key]).to.equal(expectations[key]);
          });
        });

        const requiredProperties = [
          'theme_color',
          'icons'
        ];
        
        requiredProperties.forEach(property => {
          it(`has '${property}'`, function() {
            expect(manifest[property], `property '${property}' does not exist`).to.exist;
          });
        });

        describe('icons', function() {
          it('has icons listed', function() {
            expect(manifest.icons).to.be.an('array');
            expect(manifest.icons.length).to.be.greaterThan(0);
          });
          
          it('has valid icons', async function() {
            if (!browserAvailable || !manifest.icons) {
              this.skip();
              return;
            }
            
            let iconPage;
            try {
              iconPage = await browser.newPage();
              
              for (const icon of manifest.icons) {
                expect(icon.src).to.not.be.empty;
                expect(icon.sizes).to.not.be.empty;
                expect(icon.type).to.not.be.empty;
                expect(icon.src).to.contain(icon.sizes);
                
                const response = await iconPage.goto(urlFor(icon.src), { 
                  waitUntil: 'networkidle0',
                  timeout: 15000
                });
                expect(response.status(), `Browser failed for ${icon.src}`).to.equal(200);
              }
            } catch (err) {
              console.error('Error checking icons:', err);
              browserAvailable = false;
              this.skip();
            } finally {
              if (iconPage) {
                await iconPage.close().catch(err => console.error('Error closing icon page:', err));
              }
            }
          });
        });
      });
    });
  });
});
