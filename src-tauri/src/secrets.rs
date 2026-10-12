//! Windows DPAPI wrappers, byte-compatible with Electron's `safeStorage`.
//!
//! Why this exists: `desktop/src/core/secretStore.js` seals API keys with
//! `safeStorage.encryptString`, which on Windows is `CryptProtectData` with no
//! extra entropy. The Tauri build has no Electron, so the same two primitives
//! are reimplemented here. Because the DPAPI blob format is unchanged and the
//! key material is the user's Windows credentials, **existing configs keep
//! working with no re-entry of secrets**.
//!
//! FFI is declared by hand rather than pulling in `windows-sys`: it is two
//! functions from crypt32 plus LocalFree, and hand-declaring keeps the crate
//! list short and version-proof.

use base64::Engine as _;

/// `CRYPTPROTECT_UI_FORBIDDEN` — never show a UI prompt from a headless call.
const UI_FORBIDDEN: u32 = 0x1;

#[cfg(windows)]
mod ffi {
    use std::ffi::c_void;

    #[repr(C)]
    pub struct DataBlob {
        pub cb_data: u32,
        pub pb_data: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        pub fn CryptProtectData(
            p_data_in: *const DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *const c_void,
            p_prompt_struct: *const c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;

        pub fn CryptUnprotectData(
            p_data_in: *const DataBlob,
            ppsz_data_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *const c_void,
            p_prompt_struct: *const c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn LocalFree(h_mem: *mut c_void) -> *mut c_void;
        pub fn GetLastError() -> u32;
    }
}

/// True when secrets can be sealed/unsealed on this platform.
pub fn available() -> bool {
    cfg!(windows)
}

/// plaintext -> base64(DPAPI blob). Mirrors `safeStorage.encryptString`.
#[cfg(windows)]
pub fn protect(plain: &str) -> Result<String, String> {
    let blob = protect_bytes(plain.as_bytes())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(blob))
}

/// Raw-bytes form, for wrapping the Chromium OSCrypt AES key without a lossy
/// UTF-8 round trip.
#[cfg(windows)]
pub fn protect_bytes(plain: &[u8]) -> Result<Vec<u8>, String> {
    use ffi::*;
    let mut input = plain.to_vec();
    let in_blob = DataBlob {
        cb_data: input.len() as u32,
        pb_data: input.as_mut_ptr(),
    };
    let mut out_blob = DataBlob {
        cb_data: 0,
        pb_data: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &in_blob,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 || out_blob.pb_data.is_null() {
        let code = unsafe { GetLastError() };
        return Err(format!("CryptProtectData 失败（Win32 错误 {code}）"));
    }
    let bytes = unsafe { std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize) }.to_vec();
    unsafe {
        LocalFree(out_blob.pb_data as *mut std::ffi::c_void);
    }
    Ok(bytes)
}

/// base64(DPAPI blob) -> plaintext. Mirrors `safeStorage.decryptString`.
/// Any failure is reported as an error; the host treats it as "secret unset",
/// exactly like Electron did.
#[cfg(windows)]
pub fn unprotect(b64: &str) -> Result<String, String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|_| "base64 解码失败".to_string())?;
    let bytes = unprotect_bytes(&raw)?;
    String::from_utf8(bytes).map_err(|_| "解密结果不是 UTF-8".to_string())
}

/// Raw-bytes form, for the Chromium OSCrypt key blob (see `host/osCrypt.js`).
#[cfg(windows)]
pub fn unprotect_bytes(raw: &[u8]) -> Result<Vec<u8>, String> {
    use ffi::*;
    if raw.is_empty() {
        return Err("密文为空".into());
    }
    let mut input = raw.to_vec();
    let in_blob = DataBlob {
        cb_data: input.len() as u32,
        pb_data: input.as_mut_ptr(),
    };
    let mut out_blob = DataBlob {
        cb_data: 0,
        pb_data: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &in_blob,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 || out_blob.pb_data.is_null() {
        // Report the Win32 code: `NTE_BAD_DATA` etc. distinguishes "this is not a
        // DPAPI blob" from "wrong user / entropy".
        let code = unsafe { GetLastError() };
        return Err(format!("CryptUnprotectData 失败（Win32 错误 {code}）"));
    }
    let bytes = unsafe { std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize) }.to_vec();
    unsafe {
        LocalFree(out_blob.pb_data as *mut std::ffi::c_void);
    }
    Ok(bytes)
}

#[cfg(not(windows))]
pub fn protect(_plain: &str) -> Result<String, String> {
    Err("当前平台没有 DPAPI".into())
}

#[cfg(not(windows))]
pub fn unprotect(_b64: &str) -> Result<String, String> {
    Err("当前平台没有 DPAPI".into())
}
