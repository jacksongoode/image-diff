#![no_std]
use core::arch::wasm32::*;

static mut SSE: u64 = 0;

/// 4 RGBA px per lane: squared RGB distance vs t2 (no sqrt), red where >= t2, transparent otherwise.
/// Returns diff pixel count; sum of squared error is left for `sse()`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn diff(a: *const v128, b: *const v128, out: *mut v128, n: usize, t2: u32) -> u32 {
    let (rgb, t, red) = (u32x4_splat(0x00ff_ffff), u32x4_splat(t2), u32x4_splat(0xff00_00ff));
    let (mut cnt, mut sse) = (u32x4_splat(0), u64x2_splat(0));
    for i in 0..n {
        let (x, y) = unsafe { (v128_load(a.add(i)), v128_load(b.add(i))) };
        let d = v128_and(v128_or(u8x16_sub_sat(x, y), u8x16_sub_sat(y, x)), rgb);
        let (lo, hi) = (u16x8_extend_low_u8x16(d), u16x8_extend_high_u8x16(d));
        let (lo, hi) = (i32x4_dot_i16x8(lo, lo), i32x4_dot_i16x8(hi, hi));
        let s = i32x4_add(i32x4_shuffle::<0, 2, 4, 6>(lo, hi), i32x4_shuffle::<1, 3, 5, 7>(lo, hi));
        let m = u32x4_ge(s, t);
        unsafe { v128_store(out.add(i), v128_and(m, red)) };
        cnt = i32x4_sub(cnt, m);
        sse = i64x2_add(sse, i64x2_add(u64x2_extend_low_u32x4(s), u64x2_extend_high_u32x4(s)));
    }
    unsafe { SSE = u64x2_extract_lane::<0>(sse) + u64x2_extract_lane::<1>(sse) };
    u32x4_extract_lane::<0>(cnt) + u32x4_extract_lane::<1>(cnt) + u32x4_extract_lane::<2>(cnt) + u32x4_extract_lane::<3>(cnt)
}

#[unsafe(no_mangle)]
pub extern "C" fn sse() -> f64 {
    unsafe { SSE as f64 }
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}
