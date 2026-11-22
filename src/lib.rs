#![no_std]
use core::arch::wasm32::*;

static mut SSE: u64 = 0;

/// Compares `chunks` 16-byte blocks (4 RGBA pixels each) of images `a` and `b`.
/// Returns how many pixels have a squared RGB distance of at least `t2`, and stores the summed
/// squared error for `sse()`. Distances stay squared, so no square root is needed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn diff(a: *const v128, b: *const v128, chunks: usize, t2: u32) -> u32 {
    let rgb = u32x4_splat(0x00ff_ffff);
    let t2 = u32x4_splat(t2);
    let mut count = u32x4_splat(0);
    let mut sse = u64x2_splat(0);
    for i in 0..chunks {
        let (x, y) = unsafe { (v128_load(a.add(i)), v128_load(b.add(i))) };
        // |x - y| per channel, alpha masked out.
        let d = v128_and(v128_or(u8x16_sub_sat(x, y), u8x16_sub_sat(y, x)), rgb);
        // Square and sum channel pairs, then add the pairs to get one squared distance per pixel.
        let (lo, hi) = (u16x8_extend_low_u8x16(d), u16x8_extend_high_u8x16(d));
        let (lo, hi) = (i32x4_dot_i16x8(lo, lo), i32x4_dot_i16x8(hi, hi));
        let dist = i32x4_add(i32x4_shuffle::<0, 2, 4, 6>(lo, hi), i32x4_shuffle::<1, 3, 5, 7>(lo, hi));
        // Comparison lanes are all ones (-1) when true, so subtracting counts them.
        count = i32x4_sub(count, u32x4_ge(dist, t2));
        sse = i64x2_add(sse, i64x2_add(u64x2_extend_low_u32x4(dist), u64x2_extend_high_u32x4(dist)));
    }
    unsafe { SSE = u64x2_extract_lane::<0>(sse) + u64x2_extract_lane::<1>(sse) };
    u32x4_extract_lane::<0>(count)
        + u32x4_extract_lane::<1>(count)
        + u32x4_extract_lane::<2>(count)
        + u32x4_extract_lane::<3>(count)
}

#[unsafe(no_mangle)]
pub extern "C" fn sse() -> f64 {
    unsafe { SSE as f64 }
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}
